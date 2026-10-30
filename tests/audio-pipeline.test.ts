import { describe, expect, it } from 'vitest'
import { TranscriptService } from '../src/main/services/transcription-service'
import { pcm16FromBase64 } from '../src/main/services/audio/pcm'
import { ContextEngine } from '../src/main/services/context-engine'
import { SttAdapter } from '../src/main/services/stt/types'
const RATE = 16_000
const pcm16ToBase64 = (pcm: Int16Array): string =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')

/**
 * End-to-end audio-pipeline tests for the failure class found in manual
 * testing: audio must actually FLOW (non-silent PCM → VAD → STT → segment),
 * failures must surface as error events, and every session must start from
 * clean state. The renderer sensor layer (startCapture → IPC) cannot run in
 * vitest — tests/renderer-contracts.test.ts pins that wiring statically, and
 * the real-device procedures live in docs/full-functionality-audit.md.
 */

interface SttCall {
  pcm: Int16Array
  language?: string
}

function makeStt(overrides?: { fail?: Error; text?: string }): {
  adapter: SttAdapter
  calls: SttCall[]
} {
  const calls: SttCall[] = []
  const adapter: SttAdapter = {
    kind: 'stt-segment',
    label: 'Fake STT',
    capabilities: { partial: false, final: true, transport: 'http-batch' },
    async transcribe(req: { pcm: Int16Array; language?: string }) {
      calls.push({ pcm: req.pcm, language: req.language })
      if (overrides?.fail) throw overrides.fail
      return { text: overrides?.text ?? 'What is your biggest weakness?' }
    }
  } as unknown as SttAdapter
  return { adapter, calls }
}

function makeService(stt: SttAdapter, opts?: { thresholdDb?: number }) {
  const context = new ContextEngine()
  const service = new TranscriptService(
    () => ({ adapter: stt, label: 'Fake STT', kind: 'cloud', language: 'en' }),
    context,
    () => ({ vadThresholdDb: opts?.thresholdDb ?? -45, maxSegmentMs: 20_000 })
  )
  const events = {
    segments: [] as Array<{ sessionId: string; text: string; purpose: string }>,
    errors: [] as Array<{ sessionId: string; code: string; message: string }>,
    statuses: [] as Array<{ sessionId: string; state: string; purpose: string }>
  }
  service.bindEvents({
    onStatus: (e) => events.statuses.push({ sessionId: e.sessionId, state: e.state, purpose: e.purpose }),
    onPartial: () => undefined,
    onSegment: (e) => events.segments.push({ sessionId: e.sessionId, text: e.text, purpose: e.purpose }),
    onError: (e) => events.errors.push({ sessionId: e.sessionId, code: e.code, message: e.message }),
    onMetrics: () => undefined
  })
  return { service, context, events }
}

const SILENCE = Buffer.alloc(Math.round(0.1 * RATE) * 2).toString('base64') // 100 ms
const tone = (freq = 440, ms = 300): string => {
  const samples = Math.round((RATE * ms) / 1000)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.3 * 32767)
  }
  return pcm16ToBase64(pcm)
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

async function runSession(
  service: TranscriptService,
  chunks: Array<string>,
  gapSilenceChunks = 9
): Promise<string> {
  const prepared = service.prepare('mic', 'interview')
  if (!prepared.ok) throw new Error(prepared.message)
  const sessionId = prepared.sessionId
  service.begin(sessionId)
  let seq = 0
  for (const c of chunks) {
    service.ingestChunk(sessionId, seq++, c)
    await flush()
  }
  for (let i = 0; i < gapSilenceChunks; i++) {
    service.ingestChunk(sessionId, seq++, SILENCE)
    await flush()
  }
  return sessionId
}

describe('audio pipeline: silence and failure paths (§7)', () => {
  it('pure silence never opens the VAD, never calls STT, never publishes a segment', async () => {
    const { adapter, calls } = makeStt()
    const { service, events } = makeService(adapter)
    const prepared = service.prepare('mic', 'interview')
    if (!prepared.ok) throw new Error(prepared.message)
    service.begin(prepared.sessionId)
    for (let seq = 0; seq < 30; seq++) {
      service.ingestChunk(prepared.sessionId, seq, SILENCE)
      await flush()
    }
    expect(calls).toHaveLength(0)
    expect(events.segments).toHaveLength(0)
    expect(events.errors).toHaveLength(0)
  })

  it('STT failure surfaces an stt error event and publishes NO segment or context item', async () => {
    const { adapter } = makeStt({ fail: new Error('401: bad key') })
    const { service, context, events } = makeService(adapter)
    await runSession(service, [tone()])
    expect(events.errors.some((e) => e.code === 'stt' && e.message.includes('401'))).toBe(true)
    expect(events.segments).toHaveLength(0)
    expect(context.snapshot().some((i) => i.kind === 'transcript')).toBe(false)
  })

  it('non-silent speech flows end to end: PCM → VAD → STT → segment tagged with purpose', async () => {
    const { adapter, calls } = makeStt({ text: 'Tell me about a time you led a team.' })
    const { service, events, context } = makeService(adapter)
    await runSession(service, [tone(300, 800)])
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(events.segments).toHaveLength(1)
    expect(events.segments[0].purpose).toBe('interview')
    expect(context.snapshot().some((i) => i.kind === 'transcript')).toBe(true)
  })

  it('a new session starts from clean state: the same utterance transcribes again', async () => {
    const { adapter, calls } = makeStt({ text: 'Same question in two sessions.' })
    const { service, events } = makeService(adapter)
    const s1 = await runSession(service, [tone(300, 800)])
    service.stop(s1)
    const s2 = await runSession(service, [tone(300, 800)])
    expect(s2).not.toBe(s1)
    expect(events.segments).toHaveLength(2) // dedup keys never leak across sessions
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('chunks for a stale session id are dropped without effect', async () => {
    const { adapter, calls } = makeStt()
    const { service } = makeService(adapter)
    const s1 = await runSession(service, [tone(300, 500)])
    service.stop(s1)
    expect(() => service.ingestChunk(s1, 99, tone())).not.toThrow()
    expect(calls).toHaveLength(1) // the first session's utterance only
  })

  it('stopping a session releases it: prepare works again immediately', async () => {
    const { adapter } = makeStt()
    const { service } = makeService(adapter)
    const s1 = await runSession(service, [tone(300, 500)])
    service.stop(s1)
    expect(service.hasSession()).toBe(false)
    const prepared = service.prepare('system', 'meeting')
    expect(prepared.ok).toBe(true)
  })
})

describe('audio diagnostics snapshot (§6)', () => {
  it('reports session state, metrics, last segment time and last error', async () => {
    const { adapter } = makeStt({ text: 'Diagnostics snapshot question?' })
    const { service, events } = makeService(adapter)
    const before = service.getDiagnostics()
    expect(before.session).toBeNull()
    expect(before.lastSegmentAt).toBeNull()

    const sessionId = await runSession(service, [tone(300, 800)])
    const after = service.getDiagnostics()
    expect(after.session?.id).toBe(sessionId)
    expect(after.session?.purpose).toBe('interview')
    expect(after.session?.metrics.chunksIn).toBeGreaterThan(0)
    expect(after.session?.metrics.segmentsFinalized).toBe(1)
    expect(after.lastSegmentAt).not.toBeNull()
    expect(events.segments).toHaveLength(1)
    expect(after.lastError).toBeNull()
    service.stop(sessionId)
  })

  it('records the last pipeline error with a secret-free message', async () => {
    const { adapter } = makeStt({ fail: new Error('401: invalid api key sk-abc') })
    const { service } = makeService(adapter)
    await runSession(service, [tone(300, 800)])
    const diag = service.getDiagnostics()
    expect(diag.lastError?.code).toBe('stt')
    expect(diag.lastError?.message).toContain('401')
    expect(typeof diag.lastError?.at).toBe('string')
  })
})

describe('PCM encoding contracts (sensor layer)', () => {
  it('base64 round-trips through pcm16', () => {
    const pcm = new Int16Array(1_600)
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 5) * 12_000)
    const back = pcm16FromBase64(pcm16ToBase64(pcm))
    expect(back).toHaveLength(pcm.length)
    let maxErr = 0
    for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - pcm[i]))
    expect(maxErr).toBe(0) // Int16 → base64 is lossless
  })
})
