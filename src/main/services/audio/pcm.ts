/**
 * PCM16 audio utilities shared by the VAD, segment builder, and STT adapters.
 * Pure functions only: no Node or Electron imports, fully unit-tested.
 */

/** Decode base64 to Int16Array (little-endian PCM16). */
export function pcm16FromBase64(b64: string): Int16Array {
  const buffer = Buffer.from(b64, 'base64')
  const sampleCount = Math.floor(buffer.length / 2)
  const out = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buffer.readInt16LE(i * 2)
  }
  return out
}

/** Concatenate Int16Array chunks into one buffer. */
export function concatPcm16(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** RMS of a PCM16 buffer, expressed in dBFS (0 dBFS = full-scale sine peak). */
export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return -Infinity
  let sumSquares = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768
    sumSquares += v * v
  }
  const rms = Math.sqrt(sumSquares / pcm.length)
  if (rms <= 0) return -Infinity
  return 20 * Math.log10(rms)
}

/** Wrap PCM16 samples in a minimal RIFF/WAVE container (mono, given rate). */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true)
  return out
}
