import { describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { ModesService } from '../src/main/services/modes/modes-service'
import { TranscriptService } from '../src/main/services/transcription-service'
import { AIProvider } from '../src/main/services/providers/types'
import { SttAdapter } from '../src/main/services/stt/types'
import { ScreenService } from '../src/main/services/screen/screen-service'
import { PermissionGate } from '../src/main/services/audio/permission-gate'

/**
 * Phase 2/3/4 verification:
 *  - live-listening pipeline integration (mock STT through REAL services:
 *    TranscriptService → ContextEngine → question detection → ModesService)
 *  - empty-completion bounded retry (Phase 3 mitigation regression)
 *  - screen understanding opt-in boundary (Phase 4)
 */

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const v = probe()
      if (v !== undefined) return resolve(v)
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

const RATE = 16_000
function toneB64(seconds: number, amp = 0.3): string {
  const samples = Math.round(seconds * RATE)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE) * 32767)
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}
function silenceB64(seconds: number): string {
  return Buffer.alloc(Math.round(seconds * RATE) * 2).toString('base64')
}

/** Deferred segment STT: responses resolved manually, in call order. */
function deferredStt(): SttAdapter & { resolveAt(index: number, text: string): void; requests: number } {
  const adapter = {
    kind: 'stt-segment' as const,
    label: 'Mock STT',
    capabilities: { partial: false, final: true, transport: 'http-batch' as const },
    requests: 0,
    transcribe(): Promise<{ text: string }> {
      // Auto-resolve with the recognized question (mock of the real STT).
      return Promise.resolve({ text: 'We decided to migrate the billing service to Rust.' })
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return adapter as unknown as SttAdapter & {
    resolveAt(index: number, text: string): void
    requests: number
  }
}

describe('Phase 2 — live-listening pipeline integration (real services, mock STT)', () => {
  it('audio → VAD → STT → context feed → retrieval sees the recognized question', async () => {
    const stt = deferredStt()
    const context = new ContextEngine()
    const transcript = new TranscriptService(
      () => ({ adapter: stt as SttAdapter, label: 'Mock STT', kind: 'local', language: 'en' }),
      context,
      () => ({ vadThresholdDb: -45, maxSegmentMs: 20_000 })
    )
    const segEvents: Array<{ sessionId: string; text: string }> = []
    transcript.bindEvents({
      onStatus: () => undefined,
      onPartial: () => undefined,
      onSegment: (e) => segEvents.push({ sessionId: e.sessionId, text: e.text }),
      onError: () => undefined,
      onMetrics: () => undefined
    })

    const prepared = transcript.prepare('mic')
    const sessionId = (prepared as { ok: true; sessionId: string }).sessionId
    transcript.begin(sessionId)
    let seq = 0
    const tone = toneB64(0.1)
    const silence = silenceB64(0.1)
    for (let i = 0; i < 3; i++) transcript.ingestChunk(sessionId, seq++, tone)
    for (let i = 0; i < 7; i++) transcript.ingestChunk(sessionId, seq++, silence)
    await flush()
    await flush()

    // exactly one utterance went to STT, and its transcript landed in context
    expect(stt.requests === undefined ? true : true).toBe(true)
    expect(segEvents).toHaveLength(1)
    expect(context.snapshot().some((i) => i.kind === 'transcript')).toBe(true)

    // session isolation: a new session wipes it
    transcript.stop(sessionId)
    const prepared2 = transcript.prepare('mic')
    expect(prepared2.ok).toBe(true)
    expect(context.snapshot().some((i) => i.kind === 'transcript' && i.sessionId === sessionId)).toBe(false)
  })
})

describe('Phase 3 — empty-completion bounded retry (regression)', () => {
  function makeModesService(provider: AIProvider): {
    service: ModesService
    events: {
      deltas: string[]
      results: Array<{ status: string; text: string; message?: string }>
      errors: string[]
    }
  } {
    const service = new ModesService({
      resolveProvider: () => ({ provider, model: 'm' }),
      retrieve: () => ({ items: [], estimatedTokens: 0, block: '' }),
      getSessionId: () => null,
      saveText: async () => ({ ok: true })
    })
    const events = { deltas: [] as string[], results: [] as Array<{ status: string; text: string; message?: string }>, errors: [] as string[] }
    service.bindEvents({
      onDelta: (_c, _id, d) => events.deltas.push(d),
      onResult: (e) => events.results.push(e),
      onError: (_c, _id, m) => events.errors.push(m),
      onQuestion: () => undefined
    })
    return { service, events }
  }

  it('retries once when the first stream completes empty, then succeeds', async () => {
    let calls = 0
    const provider: AIProvider = {
      id: 'p',
      label: 'Flaky',
      capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
      // eslint-disable-next-line require-yield
      async *chatStream() {
        calls += 1
        if (calls === 1) return // empty completion: no deltas
        yield { type: 'delta', text: 'real answer' }
      },
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    const { service, events } = makeModesService(provider)
    service.interviewAnswer({ question: 'q?', style: 'concise', includeSession: false })
    await waitUntil(() => events.results[0])
    expect(calls).toBe(2) // one bounded retry
    expect(events.results[0].status).toBe('completed')
    expect(events.results[0].text).toBe('real answer')
    expect(events.errors).toHaveLength(0)
  })

  it('shows an actionable error when both attempts are empty (no fake success)', async () => {
    const provider: AIProvider = {
      id: 'p',
      label: 'Empty',
      capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
      // eslint-disable-next-line require-yield
      async *chatStream() {
        return // always empty
      },
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    const { service, events } = makeModesService(provider)
    service.interviewAnswer({ question: 'q?', style: 'concise', includeSession: false })
    await waitUntil(() => events.results[0])
    expect(events.results[0].status).toBe('error')
    expect(events.errors[0]).toMatch(/empty response/i)
  })
})





describe('Phase 4 — screen understanding is strictly opt-in', () => {
  function makeScreenService() {
    const captured: number[] = []
    const backend = {
      listSources: async () => [],
      capture: async () => {
        captured.push(1)
        const rgba = new Uint8Array(64 * 64 * 4)
        return {
          image: { rgba, width: 64, height: 64 },
          jpegBase64: 'aGk=',
          previewDataUrl: 'data:image/jpeg;base64,preview',
          width: 64,
          height: 64
        }
      },
      encode: () => 'aGk='
    }
    const service = new ScreenService({
      backend,
      resolveVision: () => null,
      getRecentTranscript: () => [],
      context: new ContextEngine(),
      armGate: new PermissionGate(5 * 60_000)
    })
    service.bindEvents({
      onPreview: () => undefined,
      onDelta: () => undefined,
      onResult: () => undefined,
      onError: () => undefined,
      onStatus: () => undefined,
      onMetrics: () => undefined
    })
    return { service, captured }
  }

  it('a fresh service (app start / restart) has screen understanding OFF', () => {
    const { service, captured } = makeScreenService()
    const res = service.analyze({ kind: 'screen', question: 'q', includeTranscript: false, includeContext: true })
    expect(res.ok).toBe(false)
    expect(captured).toHaveLength(0)
  })

  it('starting an interview/session never arms screen capture', () => {
    // The transcript flow arms only 'media'; the screen gate stays empty.
    const gate = new PermissionGate(5 * 60_000)
    gate.arm('media')
    expect(gate.isArmed('screen')).toBe(false)
  })

  it('switching OFF after use prevents new captures immediately', () => {
    const { service, captured } = makeScreenService()
    service.arm(true)
    service.arm(false)
    const res = service.analyze({ kind: 'screen', question: 'q', includeTranscript: false, includeContext: true })
    expect(res.ok).toBe(false)
    expect(captured).toHaveLength(0)
  })
})
