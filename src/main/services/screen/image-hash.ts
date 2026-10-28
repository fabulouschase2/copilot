/**
 * Pure image analysis core (Module B).
 *
 * Operates on raw RGBA buffers so the whole module is unit-testable without
 * Electron. The Electron glue converts nativeImage bitmaps (BGRA) to RGBA
 * before calling in; heavier ops (resize, JPEG encode) stay on nativeImage
 * at runtime.
 *
 * Privacy: nothing here logs, persists, or transmits anything.
 */

/** Maximum accepted image dimensions (post-capture guard). */
export const MAX_IMAGE_DIMENSION = 4_096
/** Provider payload is capped by resizing to this long side before encode. */
export const ANALYSIS_MAX_LONG_SIDE = 1_280

export interface RawImage {
  /** RGBA, width*height*4 bytes. */
  rgba: Uint8Array
  width: number
  height: number
}

export function validateImage(img: RawImage): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width <= 0 || img.height <= 0) {
    return { ok: false, message: 'Image has invalid dimensions' }
  }
  if (img.width > MAX_IMAGE_DIMENSION || img.height > MAX_IMAGE_DIMENSION) {
    return { ok: false, message: `Image exceeds the ${MAX_IMAGE_DIMENSION}px dimension limit` }
  }
  if (img.rgba.length !== img.width * img.height * 4) {
    return { ok: false, message: 'Image buffer size does not match its dimensions' }
  }
  return { ok: true }
}

/** Crop rect is normalized (0..1); returns pixel bounds clamped to the image. */
export function cropRect(
  width: number,
  height: number,
  region: { x: number; y: number; w: number; h: number }
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.round(region.x * width)
  const y = Math.round(region.y * height)
  const w = Math.round(region.w * width)
  const h = Math.round(region.h * height)
  if (w <= 0 || h <= 0) return null
  const cx = Math.max(0, Math.min(x, width - 1))
  const cy = Math.max(0, Math.min(y, height - 1))
  return {
    x: cx,
    y: cy,
    width: Math.min(w, width - cx),
    height: Math.min(h, height - cy)
  }
}

/** Nearest-neighbour crop of an RGBA buffer. */
export function cropImage(img: RawImage, rect: { x: number; y: number; width: number; height: number }): RawImage {
  const out = new Uint8Array(rect.width * rect.height * 4)
  for (let row = 0; row < rect.height; row++) {
    const srcStart = ((row + rect.y) * img.width + rect.x) * 4
    out.set(img.rgba.subarray(srcStart, srcStart + rect.width * 4), row * rect.width * 4)
  }
  return { rgba: out, width: rect.width, height: rect.height }
}

/**
 * 16x16 average hash (aHash) over grayscale. Stable under small pixel noise,
 * cheap (256 pixels), good enough for duplicate detection of UI screenshots.
 */
export const HASH_SIZE = 16

export function averageHash(img: RawImage): Uint8Array {
  // Box-average the image down to HASH_SIZE x HASH_SIZE grayscale values.
  const cellW = img.width / HASH_SIZE
  const cellH = img.height / HASH_SIZE
  const gray = new Float64Array(HASH_SIZE * HASH_SIZE)
  for (let y = 0; y < img.height; y++) {
    const gy = Math.min(HASH_SIZE - 1, Math.floor(y / cellH))
    for (let x = 0; x < img.width; x++) {
      const gx = Math.min(HASH_SIZE - 1, Math.floor(x / cellW))
      const i = (y * img.width + x) * 4
      gray[gy * HASH_SIZE + gx] += 0.299 * img.rgba[i] + 0.587 * img.rgba[i + 1] + 0.114 * img.rgba[i + 2]
    }
  }
  const counts = new Float64Array(HASH_SIZE * HASH_SIZE)
  for (let y = 0; y < img.height; y++) {
    const gy = Math.min(HASH_SIZE - 1, Math.floor(y / cellH))
    for (let x = 0; x < img.width; x++) {
      counts[gy * HASH_SIZE + Math.min(HASH_SIZE - 1, Math.floor(x / cellW))] += 1
    }
  }
  for (let i = 0; i < gray.length; i++) gray[i] /= Math.max(1, counts[i])
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length
  const bits = new Uint8Array(HASH_SIZE * HASH_SIZE)
  for (let i = 0; i < gray.length; i++) bits[i] = gray[i] >= mean ? 1 : 0
  return bits
}

/** Hamming distance between two equal-length bit hashes. */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1
  return d
}

/** Similarity in 0..1 derived from hash distance. */
export function hashSimilarity(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  return 1 - hammingDistance(a, b) / a.length
}

/** Two captures within this similarity are considered the same screen. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.98

/** Keep a bounded ring of recent hashes for duplicate detection. */
export class HashRing {
  private hashes: Uint8Array[] = []

  constructor(private capacity = 8) {}

  push(hash: Uint8Array): void {
    this.hashes.push(hash)
    if (this.hashes.length > this.capacity) this.hashes.shift()
  }

  clear(): void {
    this.hashes = []
  }

  /** Best similarity against the ring (0 when empty). */
  bestSimilarity(hash: Uint8Array): number {
    let best = 0
    for (const h of this.hashes) {
      const s = hashSimilarity(h, hash)
      if (s > best) best = s
    }
    return best
  }
}
