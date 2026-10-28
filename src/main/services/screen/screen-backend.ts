/**
 * Screen capture backend (Module B).
 *
 * The interface keeps the ScreenService engine pure and unit-testable; the
 * Electron implementation (bottom of this file) uses main-process
 * desktopCapturer + nativeImage. Importing this module therefore requires
 * Electron — the service under test never imports it.
 */
import * as electron from 'electron'
import { RawImage, ANALYSIS_MAX_LONG_SIDE, cropRect, cropImage } from './image-hash'
import { ScreenKind } from '../../../shared/protocol'

export interface ScreenSource {
  id: string
  name: string
  thumbnailDataUrl: string
}

export interface CapturedScreen {
  image: RawImage
  /** JPEG (base64, no data: prefix) at the analysis resolution. */
  jpegBase64: string
  /** JPEG data URL sized for the preview panel. */
  previewDataUrl: string
  width: number
  height: number
}

export interface ScreenBackend {
  listSources(kind: ScreenKind): Promise<ScreenSource[]>
  capture(kind: ScreenKind, sourceId: string | undefined): Promise<CapturedScreen>
  /** Encode a (possibly cropped) RGBA image as base64 JPEG for the provider. */
  encode(image: RawImage): string
}

/** Long side the captured image is resized down to before encoding. */
const CAPTURE_MAX_LONG_SIDE = ANALYSIS_MAX_LONG_SIDE
const PREVIEW_LONG_SIDE = 640

export class ElectronScreenBackend implements ScreenBackend {
  async listSources(kind: ScreenKind): Promise<ScreenSource[]> {
    const sources = await electron.desktopCapturer.getSources({
      types: kind === 'screen' ? ['screen'] : ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    return sources
      .filter((s) => !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnailDataUrl: s.thumbnail.resize({ width: 160 }).toDataURL()
      }))
  }

  encode(image: RawImage): string {
    // nativeImage expects BGRA; convert RGBA back before creating the image.
    const bgra = new Uint8Array(image.rgba.length)
    for (let i = 0; i < image.rgba.length; i += 4) {
      bgra[i] = image.rgba[i + 2]
      bgra[i + 1] = image.rgba[i + 1]
      bgra[i + 2] = image.rgba[i]
      bgra[i + 3] = image.rgba[i + 3]
    }
    const img = electron.nativeImage.createFromBitmap(Buffer.from(bgra.buffer, 0, bgra.length), {
      width: image.width,
      height: image.height
    })
    return img.toJPEG(82).toString('base64')
  }

  async capture(kind: ScreenKind, sourceId: string | undefined): Promise<CapturedScreen> {
    const sources = await electron.desktopCapturer.getSources({
      types: kind === 'screen' ? ['screen'] : ['window'],
      thumbnailSize: { width: CAPTURE_MAX_LONG_SIDE, height: CAPTURE_MAX_LONG_SIDE },
      fetchWindowIcons: false
    })
    const usable = sources.filter((s) => !s.thumbnail.isEmpty())
    if (usable.length === 0) throw new Error('No capture source available')
    const chosen =
      (sourceId ? usable.find((s) => s.id === sourceId) : undefined) ?? usable[0]

    const full = chosen.thumbnail
    const width = full.getSize().width
    const height = full.getSize().height

    // nativeImage bitmaps are BGRA on Windows; normalize to RGBA for the core.
    const bgra = full.toBitmap()
    const rgba = new Uint8Array(bgra.length)
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]
      rgba[i + 1] = bgra[i + 1]
      rgba[i + 2] = bgra[i]
      rgba[i + 3] = bgra[i + 3]
    }

    let image: RawImage = { rgba, width, height }
    // The thumbnail is already ≤ the cap on its long side in most cases; the
    // analysis pipeline re-checks and the provider layer enforces final size.

    const analysis = nativeResizeForAnalysis(full)
    if (analysis) {
      const b = analysis.toBitmap()
      const rgbaA = new Uint8Array(b.length)
      for (let i = 0; i < b.length; i += 4) {
        rgbaA[i] = b[i + 2]
        rgbaA[i + 1] = b[i + 1]
        rgbaA[i + 2] = b[i]
        rgbaA[i + 3] = b[i + 3]
      }
      image = { rgba: rgbaA, width: analysis.getSize().width, height: analysis.getSize().height }
    }

    const jpegBase64 = analysis
      ? analysis.toJPEG(82).toString('base64')
      : full.toJPEG(82).toString('base64')
    const previewDataUrl = full
      .resize({ width: PREVIEW_LONG_SIDE })
      .toJPEG(70)
      .toString('base64')

    return {
      image,
      jpegBase64,
      previewDataUrl: `data:image/jpeg;base64,${previewDataUrl}`,
      width: image.width,
      height: image.height
    }
  }
}

/** Resize so the long side ≤ cap, preserving aspect. Null if already small. */
function nativeResizeForAnalysis(img: electron.NativeImage): electron.NativeImage | null {
  const { width, height } = img.getSize()
  const long = Math.max(width, height)
  if (long <= CAPTURE_MAX_LONG_SIDE) return null
  const scale = CAPTURE_MAX_LONG_SIDE / long
  return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
}

export { cropRect, cropImage }
