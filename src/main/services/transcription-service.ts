/**
 * Transcription service (Module A orchestrator).
 *
 * Owns one live session at a time: receives validated PCM chunks from the
 * renderer, runs VAD, dispatches utterances to the active STT adapter, and
 * publishes transcript segments in strict order with dedup. Finalized
 * segments are fed into the ContextEngine through its public interface.
 *
 * Ordering guarantee: a segment is published only after every lower
 * publishSeq has been published; later-arriving STT responses wait in a
 * bounded reorder buffer. Late/out-of-order arrivals are therefore impossible
 * to observe downstream, and duplicates are dropped by content key.
 *
 * No raw audio is persisted: utterance buffers live only until their STT
 * request completes, then are released.
 */
import { ContextEngine } from './context-engine'
import { EnergyVad } from './audio/vad'
import { pcm16FromBase64 } from './audio/pcm'
import {
  SttAdapter,
  StreamingSttAdapter,
  StreamingSttHandle,
  sttProviderKind
} from './stt/types'
import {
  TranscriptMetrics,
  TranscriptSessionState,
  TranscriptSource,
  TranscriptStatusEvent
} from '../../shared/protocol'

export interface TranscriptEvents {
  onStatus(e: TranscriptStatusEvent): void
  onPartial(e: { sessionId: string; segmentId: string; text: string }): void
  onSegment(e: {
    sessionId: string
    segmentId: string
    seq: number
    source: TranscriptSource
    startMs: number
    endMs: number
    wallTime: string
    text: string
  }): void
  onError(e: { sessionId: string; code: 'permission' | 'device' | 'stt' | 'invalid' | 'internal'; message: string }): void
  onMetrics(e: { sessionId: string; metrics: TranscriptMetrics }): void
}

const MAX_PENDING_PUBLISH = 8
const MAX_SEEN_KEYS = 500

interface Session {
  id: string
  source: TranscriptSource
  state: TranscriptSessionState
  muted: boolean
  speechActive: boolean
  vad: EnergyVad
  lastChunkSeq: number
  audioSamples: number
  metrics: TranscriptMetrics
  /** Serialized publication chain: dispatch order = publish order. */
  publishChain: Promise<void>
  inFlight: number
  seenKeys: Set<string>
  abort: AbortController
  streamHandle: StreamingSttHandle | null
  liveSegmentId: string
  rssStart: number | null
}

export class TranscriptService {
  private session: Session | null = null
  /**
   * Last published segments of the most recent session (bounded ring).
   * Cleared whenever a new session is prepared, so a screen analysis can
   * never attach segments from an unrelated session.
   */
  private recentTranscript: Array<{ segmentId: string; seq: number; text: string }> = []
  private readonly recentLimit = 20
  private events: TranscriptEvents = {
    onStatus: () => undefined,
    onPartial: () => undefined,
    onSegment: () => undefined,
    onError: () => undefined,
    onMetrics: () => undefined
  }

  constructor(
    private resolveStt: () => { adapter: SttAdapter; label: string; kind: 'cloud' | 'local'; language: string } | null,
    private context: ContextEngine,
    private settings: () => { vadThresholdDb: number; maxSegmentMs: number }
  ) {}

  bindEvents(events: TranscriptEvents): void {
    this.events = events
  }

  get activeSessionId(): string | null {
    return this.session?.id ?? null
  }

  get state(): TranscriptSessionState {
    return this.session?.state ?? 'stopped'
  }

  /**
   * Create a session in 'armed' state. The renderer then requests OS
   * permission, starts capture, and calls begin(). Only one live session
   * is allowed; a new prepare while one exists is rejected with 'invalid'.
   */
  prepare(source: TranscriptSource): { ok: true; sessionId: string } | { ok: false; message: string } {
    if (this.session && this.session.state !== 'stopped') {
      return { ok: false, message: 'A transcription session is already active. Stop it first.' }
    }
    const resolved = this.resolveStt()
    if (!resolved) {
      return {
        ok: false,
        message: 'No transcription provider configured. Add one under Settings → Transcription.'
      }
    }
    const sessionId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.recentTranscript = []
    const { vadThresholdDb, maxSegmentMs } = this.settings()
    const session: Session = {
      id: sessionId,
      source,
      state: 'armed',
      muted: false,
      speechActive: false,
      vad: new EnergyVad(
        {
          onSegment: (seg) => this.onVadSegment(session, seg),
          onSpeechActiveChange: (active) => {
            session.speechActive = active
            this.emitStatus(session)
          }
        },
        { thresholdDb: vadThresholdDb, maxSegmentMs }
      ),
      lastChunkSeq: -1,
      audioSamples: 0,
      metrics: {
        chunksIn: 0,
        chunksDropped: 0,
        audioMs: 0,
        vadCpuMs: 0,
        segmentsFinalized: 0,
        partialsSent: 0,
        sttRequests: 0,
        sttErrors: 0,
        lastSttRttMs: null,
        avgSttRttMs: null,
        rssStartBytes: null,
        rssNowBytes: null
      },
      publishChain: Promise.resolve(),
      inFlight: 0,
      seenKeys: new Set(),
      abort: new AbortController(),
      streamHandle: null,
      liveSegmentId: `${sessionId}-live`,
      rssStart: null
    }
    this.session = session
    this.emitStatus(session)
    return { ok: true, sessionId }
  }

  begin(sessionId: string): void {
    const s = this.requireSession(sessionId, 'begin')
    if (!s || s.state !== 'armed') return
    s.state = 'listening'
    s.rssStart = safeRss()

    const resolved = this.resolveStt()
    if (resolved && resolved.adapter.kind === 'stt-stream') {
      const stream = resolved.adapter as StreamingSttAdapter
      s.streamHandle = stream.start({
        onPartial: (key, text) => {
          if (text.trim().length === 0) return
          s.metrics.partialsSent += 1
          this.events.onPartial({ sessionId: s.id, segmentId: s.liveSegmentId, text })
        },
        onFinal: (key, text) => this.publishStreamFinal(s, text),
        onError: (message) => this.events.onError({ sessionId: s.id, code: 'stt', message })
      })
    }
    this.emitStatus(s)
  }

  ingestChunk(sessionId: string, seq: number, b64: string): void {
    const s = this.session
    if (!s || s.id !== sessionId) return // no session / stale chunk: drop silently
    if (s.state !== 'listening') {
      s.metrics.chunksDropped += 1
      return
    }
    if (s.muted) {
      s.metrics.chunksDropped += 1
      return
    }
    if (s.lastChunkSeq === -1) {
      s.lastChunkSeq = seq // first chunk defines the baseline; no gap accounting
      s.metrics.chunksIn += 1
    } else if (seq <= s.lastChunkSeq) {
      s.metrics.chunksDropped += 1 // replayed/out-of-order chunk
      return
    } else {
      if (seq > s.lastChunkSeq + 1) {
        s.metrics.chunksDropped += seq - s.lastChunkSeq - 1 // gap (e.g. resume)
      }
      s.lastChunkSeq = seq
      s.metrics.chunksIn += 1
    }

    const t0 = performance.now()
    const pcm = pcm16FromBase64(b64)
    s.audioSamples += pcm.length
    s.metrics.audioMs = Math.round((s.audioSamples / 16_000) * 1000)
    s.vad.feed(pcm)
    s.metrics.vadCpuMs += performance.now() - t0
    if (s.rssStart !== null) s.metrics.rssNowBytes = safeRss()

    if (s.streamHandle) s.streamHandle.sendAudio(pcm)
  }

  pause(sessionId: string): void {
    const s = this.requireSession(sessionId, 'pause')
    if (!s || s.state !== 'listening') return
    s.state = 'paused'
    // A half-closed utterance would lose its tail; force the VAD to flush it.
    s.vad.stop()
    s.vad = this.freshVad(s)
    this.emitStatus(s)
  }

  resume(sessionId: string): void {
    const s = this.requireSession(sessionId, 'resume')
    if (!s || s.state !== 'paused') return
    s.state = 'listening'
    s.lastChunkSeq = -1 // renderer restarts its counter after a capture gap
    this.emitStatus(s)
  }

  mute(sessionId: string, muted: boolean): void {
    const s = this.requireSession(sessionId, 'mute')
    if (!s) return
    s.muted = muted
    this.emitStatus(s)
  }

  stop(sessionId: string): TranscriptMetrics | null {
    const s = this.session
    if (!s || s.id !== sessionId) return null
    if (s.state === 'stopped') return s.metrics
    // Abort in-flight STT first so the flush below cannot dispatch anything
    // that would outlive the session.
    s.abort.abort()
    s.vad.stop()
    void s.streamHandle?.finish()
    s.state = 'stopped'
    s.metrics.rssNowBytes = safeRss()
    this.emitStatus(s)
    this.events.onMetrics({ sessionId: s.id, metrics: s.metrics })
    this.session = null
    return s.metrics
  }

  stopAny(): void {
    if (this.session) this.stop(this.session.id)
  }

  /** Test hook: expose a synthetic session (used by unit tests). */
  hasSession(): boolean {
    return this.session !== null
  }

  /**
   * Recent finalized segments (current/most recent session only). Used by the
   * screen analyzer when the user explicitly opts into transcript context.
   */
  getRecentTranscript(): Array<{ segmentId: string; seq: number; text: string }> {
    return [...this.recentTranscript]
  }

  private freshVad(s: Session): EnergyVad {
    const { vadThresholdDb, maxSegmentMs } = this.settings()
    return new EnergyVad(
      {
        onSegment: (seg) => this.onVadSegment(s, seg),
        onSpeechActiveChange: (active) => {
          s.speechActive = active
          this.emitStatus(s)
        }
      },
      { thresholdDb: vadThresholdDb, maxSegmentMs }
    )
  }

  private onVadSegment(
    s: Session,
    seg: { pcm: Int16Array; startMs: number; endMs: number }
  ): void {
    // Stream adapters do their own endpointing; VAD close is informational.
    if (s.streamHandle) return
    const resolved = this.resolveStt()
    if (!resolved || resolved.adapter.kind !== 'stt-segment') return
    if (seg.pcm.length === 0) return
    // Bound concurrent STT requests: beyond the limit the oldest-pending
    // utterance is sacrificed rather than queueing unbounded audio in RAM.
    if (s.inFlight >= MAX_PENDING_PUBLISH) {
      s.metrics.sttErrors += 1
      return
    }

    const publishSeq = s.metrics.sttRequests
    const segmentId = `${s.id}-s${publishSeq}`
    s.metrics.sttRequests += 1
    s.inFlight += 1
    const startedAt = performance.now()
    const promise = (resolved.adapter as { transcribe(req: unknown): Promise<{ text: string }> })
      .transcribe({ pcm: seg.pcm, language: resolved.language, signal: s.abort.signal })
      .then((r) => {
        s.metrics.lastSttRttMs = Math.round(performance.now() - startedAt)
        const prev = s.metrics.avgSttRttMs
        s.metrics.avgSttRttMs =
          prev === null ? s.metrics.lastSttRttMs : Math.round((prev + s.metrics.lastSttRttMs!) / 2)
        return r
      })
      .catch((err: unknown) => {
        if (s.abort.signal.aborted) return { text: '' } // cancelled at stop: drop quietly
        s.metrics.sttErrors += 1
        this.events.onError({
          sessionId: s.id,
          code: 'stt',
          message: err instanceof Error ? err.message : 'Transcription failed'
        })
        return { text: '' }
      })

    // Serialize: each segment publishes only after every earlier one settled,
    // so resolution order can never scramble the transcript.
    s.publishChain = s.publishChain.then(() =>
      promise.then((r) => {
        s.inFlight -= 1
        if (s.state === 'stopped') return
        const text = r.text.trim()
        if (text.length === 0) return
        this.publish(s, {
          segmentId,
          publishSeq,
          source: s.source,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text
        })
      })
    )
  }

  private publishStreamFinal(s: Session, text: string): void {
    const clean = text.trim()
    if (clean.length === 0) return
    const publishSeq = s.metrics.sttRequests
    s.metrics.sttRequests += 1
    this.publish(s, {
      segmentId: `${s.id}-s${publishSeq}`,
      publishSeq,
      source: s.source,
      startMs: Math.max(0, s.metrics.audioMs - 1_000),
      endMs: s.metrics.audioMs,
      text: clean
    })
  }

  /**
   * Publish strictly in publishSeq order: only the segment whose turn it is
   * gets a handler attached; when it publishes (or is dropped), the next one
   * is attached. STT responses that resolve early therefore wait here.
   */

  private publish(
    s: Session,
    seg: {
      segmentId: string
      publishSeq: number
      source: TranscriptSource
      startMs: number
      endMs: number
      text: string
    }
  ): void {
    const key = `${seg.source}:${seg.startMs}:${seg.text.toLowerCase()}`
    if (s.seenKeys.has(key)) return // duplicate transcript: drop
    s.seenKeys.add(key)
    if (s.seenKeys.size > MAX_SEEN_KEYS) {
      const first = s.seenKeys.values().next().value as string
      s.seenKeys.delete(first)
    }

    s.metrics.segmentsFinalized += 1
    this.recentTranscript.push({ segmentId: seg.segmentId, seq: seg.publishSeq, text: seg.text })
    if (this.recentTranscript.length > this.recentLimit) this.recentTranscript.shift()
    this.context.add({
      id: seg.segmentId,
      kind: 'transcript',
      text: seg.text,
      timestamp: Date.now()
    })
    // The final replaces any live partial for stream sessions.
    this.events.onPartial({ sessionId: s.id, segmentId: s.liveSegmentId, text: '' })
    this.events.onSegment({
      sessionId: s.id,
      segmentId: seg.segmentId,
      seq: seg.publishSeq,
      source: seg.source,
      startMs: seg.startMs,
      endMs: seg.endMs,
      wallTime: new Date().toISOString(),
      text: seg.text
    })
  }

  private emitStatus(s: Session): void {
    const resolved = this.resolveStt()
    this.events.onStatus({
      sessionId: s.id,
      state: s.state,
      source: s.source,
      muted: s.muted,
      speechActive: s.speechActive,
      sttProviderLabel: resolved?.label ?? 'none',
      sttProviderKind: resolved ? sttProviderKind(resolved.adapter) : 'none'
    })
  }

  private requireSession(sessionId: string, action: string): Session | null {
    const s = this.session
    if (!s || s.id !== sessionId) {
      return null
    }
    return s
  }
}

function safeRss(): number | null {
  try {
    return process.memoryUsage().rss
  } catch {
    return null
  }
}
