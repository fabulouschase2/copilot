import { describe, expect, it } from 'vitest'
import { EnergyVad } from '../src/main/services/audio/vad'

const RATE = 16_000

function tone(seconds: number, amp = 0.3, freq = 440): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / RATE) * 32767)
  }
  return out
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * RATE))
}

interface Collected {
  segments: Array<{ startMs: number; endMs: number; length: number }>
  activeChanges: boolean[]
}

function makeVad(opts?: { openMs?: number; hangoverMs?: number; maxSegmentMs?: number }): {
  vad: EnergyVad
  collected: Collected
} {
  const collected: Collected = { segments: [], activeChanges: [] }
  const vad = new EnergyVad(
    {
      onSegment: (seg) =>
        collected.segments.push({ startMs: seg.startMs, endMs: seg.endMs, length: seg.pcm.length }),
      onSpeechActiveChange: (a) => collected.activeChanges.push(a)
    },
    opts
  )
  return { vad, collected }
}

describe('EnergyVad', () => {
  it('stays silent through noise-floor audio', () => {
    const { vad, collected } = makeVad()
    vad.feed(silence(2))
    vad.stop()
    expect(collected.segments).toHaveLength(0)
    expect(collected.activeChanges).toHaveLength(0)
  })

  it('opens after openMs of speech and closes after hangover, including pre-roll', () => {
    const { vad, collected } = makeVad()
    vad.feed(silence(0.2))
    vad.feed(tone(0.3)) // 300 ms above threshold (open at ~120 ms)
    vad.feed(silence(1)) // hangover (700 ms) then quiet
    vad.stop()
    expect(collected.activeChanges).toEqual([true, false])
    expect(collected.segments).toHaveLength(1)
    const seg = collected.segments[0]
    // pre-roll (300 ms) + speech (300 ms) + hangover-ish tail
    expect(seg.endMs - seg.startMs).toBeGreaterThanOrEqual(500)
    expect(seg.startMs).toBeLessThanOrEqual(200) // pre-roll pulls the onset back
  })

  it('word gaps shorter than hangover do not split an utterance', () => {
    const { vad, collected } = makeVad()
    vad.feed(tone(0.3))
    vad.feed(silence(0.25)) // gap < 700 ms hangover
    vad.feed(tone(0.3))
    vad.feed(silence(1))
    vad.stop()
    expect(collected.segments).toHaveLength(1)
  })

  it('separate utterances with long gaps produce distinct segments in order', () => {
    const { vad, collected } = makeVad()
    vad.feed(tone(0.3))
    vad.feed(silence(1.2))
    vad.feed(tone(0.3))
    vad.feed(silence(1.2))
    vad.stop()
    expect(collected.segments).toHaveLength(2)
    expect(collected.segments[0].endMs).toBeLessThan(collected.segments[1].startMs)
  })

  it('force-closes a segment at maxSegmentMs to bound latency', () => {
    const { vad, collected } = makeVad({ maxSegmentMs: 1000 })
    vad.feed(tone(3)) // continuous speech > 1 s
    vad.feed(silence(1))
    vad.stop()
    expect(collected.segments.length).toBeGreaterThanOrEqual(2)
    // Duration includes the 300 ms pre-roll plus one analysis frame of slack.
    for (const seg of collected.segments) {
      expect(seg.endMs - seg.startMs).toBeLessThanOrEqual(1000 + 300 + 100)
    }
  })

  it('stop() flushes an open segment exactly once', () => {
    const { vad, collected } = makeVad()
    vad.feed(tone(0.5))
    vad.stop()
    vad.stop()
    expect(collected.segments).toHaveLength(1)
    expect(collected.activeChanges).toEqual([true, false])
  })

  it('ignores feed() after stop()', () => {
    const { vad, collected } = makeVad()
    vad.stop()
    vad.feed(tone(1))
    expect(collected.segments).toHaveLength(0)
  })
})
