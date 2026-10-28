import { describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { EnergyVad } from '../src/main/services/audio/vad'
import { pcm16FromBase64 } from '../src/main/services/audio/pcm'
import { TranscriptService } from '../src/main/services/transcription-service'
import { SttAdapter } from '../src/main/services/stt/types'

/**
 * Stage 5 performance measurement on the actual development machine
 * (Windows 11, Node 26, this laptop). Numbers are printed for the stage
 * report; assertions only guard against pathological regressions.
 */

const RATE = 16_000
const CHUNK_MS = 100
const SESSION_SECONDS = 60

function tone(seconds: number, amp = 0.3): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE) * 32767)
  }
  return out
}

function b64Of(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

describe('Stage 5 performance (measured, printed for the report)', () => {
  it('VAD hot path processes a 60-minute synthetic stream far faster than realtime', { timeout: 60_000 }, () => {
    const minutes = 60
    const toneChunk = b64Of(tone(CHUNK_MS / 1000))
    const silenceChunk = b64Of(new Int16Array((CHUNK_MS / 1000) * RATE))
    let segments = 0
    const vad = new EnergyVad(
      {
        onSegment: () => {
          segments += 1
        },
        onSpeechActiveChange: () => undefined
      },
      { thresholdDb: -45, maxSegmentMs: 20_000 }
    )

    const rssBefore = process.memoryUsage().rss
    const started = performance.now()
    let vadCpuMs = 0
    const totalChunks = minutes * 60 * (1000 / CHUNK_MS)
    for (let i = 0; i < totalChunks; i++) {
      // Pattern: 5 s speech every 30 s (10 speech chunks, 20 silence per cycle).
      const isSpeech = i % 30 < 10
      const t0 = performance.now()
      vad.feed(pcm16FromBase64(isSpeech ? toneChunk : silenceChunk))
      vadCpuMs += performance.now() - t0
    }
    const wallMs = performance.now() - started
    const rssAfter = process.memoryUsage().rss
    const streamSeconds = minutes * 60

    // eslint-disable-next-line no-console
    console.log(
      `[perf] VAD stream: ${streamSeconds}s audio in ${wallMs.toFixed(1)} ms wall ` +
        `(${(streamSeconds / (wallMs / 1000)).toFixed(0)}x realtime), ` +
        `decode+VAD cpu ${vadCpuMs.toFixed(1)} ms (${((vadCpuMs / (streamSeconds * 1000)) * 100).toFixed(3)}% of one core), ` +
        `${segments} segments, RSS ${((rssAfter - rssBefore) / 1048576).toFixed(1)} MB delta`
    )

    expect(wallMs).toBeLessThan(streamSeconds * 1000 * 0.05) // ≥20x realtime
  })

  it('full pipeline (decode+VAD+STT dispatch, instant STT) sustains realtime for 60 s', { timeout: 60_000 }, async () => {
    const adapter: SttAdapter = {
      kind: 'stt-segment',
      label: 'Perf Mock',
      capabilities: { partial: false, final: true, transport: 'http-batch' },
      transcribe: async () => ({ text: 'synthetic utterance' }),
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    const context = new ContextEngine()
    const service = new TranscriptService(
      () => ({ adapter, label: 'Perf Mock', kind: 'cloud', language: 'en' }),
      context,
      () => ({ vadThresholdDb: -45, maxSegmentMs: 20_000 })
    )
    let published = 0
    service.bindEvents({ onStatus: () => undefined, onPartial: () => undefined, onSegment: () => { published += 1 }, onError: () => undefined, onMetrics: () => undefined })

    const prepared = service.prepare('mic')
    const sessionId = (prepared as { ok: true; sessionId: string }).sessionId
    service.begin(sessionId)

    const toneChunk = b64Of(tone(CHUNK_MS / 1000))
    const silenceChunk = b64Of(new Int16Array((CHUNK_MS / 1000) * RATE))
    const rssBefore = process.memoryUsage().rss
    const started = performance.now()
    const totalChunks = SESSION_SECONDS * (1000 / CHUNK_MS)
    for (let i = 0; i < totalChunks; i++) {
      const isSpeech = i % 30 < 10
      service.ingestChunk(sessionId, i, isSpeech ? toneChunk : silenceChunk)
      // Yield every 10 chunks so in-flight STT promises settle (realtime-like).
      if (i % 10 === 9) await new Promise((r) => setImmediate(r))
    }
    await new Promise((r) => setImmediate(r))
    const wallMs = performance.now() - started
    const metrics = service.stop(sessionId)
    const rssAfter = process.memoryUsage().rss

    // eslint-disable-next-line no-console
    console.log(
      `[perf] pipeline 60 s: wall ${wallMs.toFixed(1)} ms (${(SESSION_SECONDS / (wallMs / 1000)).toFixed(0)}x realtime), ` +
        `${published} segments published, avg STT rtt ${metrics?.avgSttRttMs ?? '-'} ms, ` +
        `VAD cpu ${metrics?.vadCpuMs.toFixed(1) ?? '-'} ms, RSS delta ${((rssAfter - rssBefore) / 1048576).toFixed(1)} MB`
    )

    expect(published).toBeGreaterThan(10)
    expect(wallMs).toBeLessThan(SESSION_SECONDS * 1000 * 0.25) // ≥4x realtime incl. yields
  })
})
