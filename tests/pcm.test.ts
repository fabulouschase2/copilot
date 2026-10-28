import { describe, expect, it } from 'vitest'
import { concatPcm16, encodeWav, pcm16FromBase64, rmsDbfs } from '../src/main/services/audio/pcm'

function sinePcm(seconds: number, freq = 440, amp = 0.3, rate = 16_000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate) * 32767)
  }
  return out
}

describe('pcm utilities', () => {
  it('round-trips base64 PCM16', () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 1234, -1234])
    const b64 = Buffer.from(original.buffer, 0, original.length * 2).toString('base64')
    const decoded = pcm16FromBase64(b64)
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })

  it('rmsDbfs classifies loud tone, noise floor and silence', () => {
    const loud = rmsDbfs(sinePcm(0.1, 440, 0.5))
    expect(loud).toBeGreaterThan(-12)
    expect(loud).toBeLessThan(-2)
    const quiet = rmsDbfs(sinePcm(0.1, 440, 0.001))
    expect(quiet).toBeLessThan(-60)
    expect(rmsDbfs(new Int16Array(1600))).toBe(-Infinity)
  })

  it('concatPcm16 preserves order and length', () => {
    const a = new Int16Array([1, 2])
    const b = new Int16Array([3, 4, 5])
    expect(Array.from(concatPcm16([a, b]))).toEqual([1, 2, 3, 4, 5])
  })

  it('encodeWav produces a valid RIFF header for the sample count', () => {
    const pcm = sinePcm(0.05)
    const wav = encodeWav(pcm, 16_000)
    const text = Buffer.from(wav.buffer, 0, 44).toString('ascii')
    expect(text.startsWith('RIFF')).toBe(true)
    expect(text.slice(8, 12)).toBe('WAVE')
    expect(wav.length).toBe(44 + pcm.length * 2)
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(pcm.length * 2)
    // first sample round-trips through the data chunk
    expect(view.getInt16(44, true)).toBe(pcm[0])
  })
})
