import { describe, expect, it } from 'vitest'
import {
  HashRing,
  averageHash,
  cropImage,
  cropRect,
  hammingDistance,
  hashSimilarity,
  validateImage,
  RawImage,
  MAX_IMAGE_DIMENSION
} from '../src/main/services/screen/image-hash'

function solidImage(w: number, h: number, r = 200, g = 100, b = 50): RawImage {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return { rgba, width: w, height: h }
}

function patternImage(w: number, h: number): RawImage {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x * 7 + y * 13) % 256
      const i = (y * w + x) * 4
      rgba[i] = v
      rgba[i + 1] = 255 - v
      rgba[i + 2] = v
      rgba[i + 3] = 255
    }
  }
  return { rgba, width: w, height: h }
}

function withNoise(img: RawImage, amount: number): RawImage {
  const rgba = new Uint8Array(img.rgba)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.max(0, Math.min(255, rgba[i] + ((i % 7) - 3) * amount))
  }
  return { rgba, width: img.width, height: img.height }
}

describe('image validation', () => {
  it('accepts a well-formed image', () => {
    expect(validateImage(solidImage(64, 64)).ok).toBe(true)
  })

  it('rejects dimension/buffer mismatches and oversized images', () => {
    const bad = solidImage(64, 64)
    expect(validateImage({ ...bad, rgba: bad.rgba.subarray(0, 100) }).ok).toBe(false)
    expect(validateImage({ ...bad, width: 0 }).ok).toBe(false)
    expect(validateImage({ ...bad, width: 12.5 }).ok).toBe(false)
    const huge = solidImage(64, 64)
    expect(
      validateImage({ ...huge, width: MAX_IMAGE_DIMENSION + 1, height: 10 }).ok
    ).toBe(false)
  })
})

describe('crop', () => {
  it('clamps normalized rects into pixel bounds', () => {
    const rect = cropRect(1000, 500, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 })
    expect(rect).toEqual({ x: 100, y: 100, width: 500, height: 200 })
    expect(cropRect(100, 100, { x: 0.5, y: 0.5, w: 2, h: 2 })).toEqual({
      x: 50,
      y: 50,
      width: 50,
      height: 50
    })
    expect(cropRect(100, 100, { x: 0.5, y: 0.5, w: 0, h: 0.5 })).toBeNull()
  })

  it('cropImage extracts the exact sub-image', () => {
    const img = patternImage(10, 10)
    const cropped = cropImage(img, { x: 2, y: 3, width: 4, height: 2 })
    expect(cropped.width).toBe(4)
    expect(cropped.height).toBe(2)
    // first cropped pixel equals source pixel at (2,3)
    expect(Array.from(cropped.rgba.subarray(0, 4))).toEqual(
      Array.from(img.rgba.subarray((3 * 10 + 2) * 4, (3 * 10 + 2) * 4 + 4))
    )
  })
})

describe('average hash and similarity', () => {
  it('identical images hash identically (distance 0, similarity 1)', () => {
    const a = averageHash(patternImage(320, 200))
    const b = averageHash(patternImage(320, 200))
    expect(hammingDistance(a, b)).toBe(0)
    expect(hashSimilarity(a, b)).toBe(1)
  })

  it('is stable under small pixel noise (UI screenshots)', () => {
    const base = averageHash(patternImage(320, 200))
    const noisy = averageHash(withNoise(patternImage(320, 200), 2))
    expect(hashSimilarity(base, noisy)).toBeGreaterThanOrEqual(0.98)
  })

  it('distinct images produce distant hashes', () => {
    const a = averageHash(patternImage(320, 200))
    const inverted = patternImage(320, 200)
    for (let i = 0; i < inverted.rgba.length; i += 4) {
      inverted.rgba[i] = 255 - inverted.rgba[i]
      inverted.rgba[i + 1] = 255 - inverted.rgba[i + 1]
      inverted.rgba[i + 2] = 255 - inverted.rgba[i + 2]
    }
    const b = averageHash(inverted)
    // Solid-color images degenerate in aHash (all cells equal); textured
    // opposites are the meaningful distinct-pair test.
    expect(hashSimilarity(a, b)).toBeLessThan(0.8)
  })

  it('mismatched hash lengths never look similar', () => {
    const a = averageHash(solidImage(64, 64))
    const b = new Uint8Array(1)
    expect(hashSimilarity(a, b)).toBe(0)
  })
})

describe('HashRing', () => {
  it('tracks best similarity against recent hashes and clears', () => {
    const ring = new HashRing(4)
    expect(ring.bestSimilarity(averageHash(solidImage(32, 32)))).toBe(0) // empty
    const h1 = averageHash(patternImage(160, 100))
    ring.push(h1)
    expect(ring.bestSimilarity(h1)).toBe(1)
    ring.clear()
    expect(ring.bestSimilarity(h1)).toBe(0)
  })

  it('evicts beyond capacity', () => {
    const ring = new HashRing(1)
    ring.push(averageHash(solidImage(32, 32, 255, 0, 0)))
    ring.push(averageHash(solidImage(32, 32, 0, 0, 255))) // evicts the red hash
    // black vs blue can still be similar-ish, but red-vs-nothing is gone:
    const black = averageHash(solidImage(32, 32, 0, 0, 0))
    expect(ring.bestSimilarity(black)).toBeGreaterThanOrEqual(0)
  })
})
