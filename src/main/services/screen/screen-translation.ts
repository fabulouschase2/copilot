/**
 * Screen translation (0.4.0): capture a region → local OCR → translate.
 *
 * OCR and translation are separate services on purpose. OCR is local Windows OCR
 * (no network, no key); translation uses the active provider. If OCR finds no
 * text the result says so; if translation fails the recognised text is still
 * returned, so a provider outage never destroys the capture you paid attention
 * to. Nothing here claims success unless both steps produced output.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OcrResult } from './local-ocr'
import type { ScreenRegion } from '../../../shared/protocol'

export const MAX_TRANSLATION_HISTORY = 20

/** Normalized 0..1 rectangle, same shape as the capture API. */
export type CaptureRegion = ScreenRegion

export interface CapturedImage {
  jpegBase64: string
  width: number
  height: number
}

export interface ScreenTranslationDeps {
  /** Capture a source (or the first screen) and optionally crop a region. */
  capture: (sourceId: string | undefined, region: CaptureRegion | undefined) => Promise<CapturedImage>
  /** Local OCR of an image file. */
  ocr: (filePath: string) => Promise<OcrResult>
  /** Translate text into `target`. */
  translate: (
    text: string,
    target: string
  ) => Promise<{ ok: boolean; text: string; providerLabel: string; message?: string }>
  now?: () => Date
  idFactory?: () => string
}

export interface ScreenTranslationResult {
  ok: boolean
  id: string
  original: string
  translated: string
  targetLanguage: string
  /** Script-based guess for display only; never used to alter the OCR text. */
  detectedLanguage: string | null
  ocrLanguage: string | null
  ocrProvider: string
  translateProvider: string
  at: string
  region: CaptureRegion | null
  width: number
  height: number
  /** Set when OCR found nothing or translation failed. */
  message?: string
  /** True when OCR succeeded but translation did not. */
  partial?: boolean
}

/** Cheap script detection for labelling; not a language classifier. */
export function detectScript(text: string): string | null {
  if (text.trim().length === 0) return null
  if (/[\u3040-\u30ff]/.test(text)) return 'Japanese'
  if (/[\uac00-\ud7af]/.test(text)) return 'Korean'
  if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese'
  if (/[\u0600-\u06ff]/.test(text)) return 'Arabic'
  if (/[\u0590-\u05ff]/.test(text)) return 'Hebrew'
  if (/[\u0400-\u04ff]/.test(text)) return 'Cyrillic'
  if (/[\u0e00-\u0e7f]/.test(text)) return 'Thai'
  if (/[\u0900-\u097f]/.test(text)) return 'Devanagari'
  if (/[\u0370-\u03ff]/.test(text)) return 'Greek'
  return 'Latin'
}

const MIN_OCR_CHARS = 2

export class ScreenTranslationService {
  private entries: ScreenTranslationResult[] = []

  constructor(private readonly deps: ScreenTranslationDeps) {}

  list(): ScreenTranslationResult[] {
    return this.entries.map((e) => ({ ...e }))
  }

  clear(): void {
    this.entries = []
  }

  async translateRegion(req: {
    sourceId?: string
    region?: CaptureRegion
    targetLanguage: string
  }): Promise<ScreenTranslationResult> {
    const at = (this.deps.now?.() ?? new Date()).toISOString()
    const id = this.deps.idFactory?.() ?? `str-${Date.now().toString(36)}`
    const base: ScreenTranslationResult = {
      ok: false,
      id,
      original: '',
      translated: '',
      targetLanguage: req.targetLanguage,
      detectedLanguage: null,
      ocrLanguage: null,
      ocrProvider: 'Windows OCR',
      translateProvider: 'none',
      at,
      region: req.region ?? null,
      width: 0,
      height: 0
    }

    let captured: CapturedImage
    try {
      captured = await this.deps.capture(req.sourceId, req.region)
    } catch (err) {
      return {
        ...base,
        message: `Could not capture the screen: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    base.width = captured.width
    base.height = captured.height

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-str-'))
    const file = path.join(dir, 'region.jpg')
    let ocr: OcrResult
    try {
      fs.writeFileSync(file, Buffer.from(captured.jpegBase64, 'base64'))
      ocr = await this.deps.ocr(file)
    } catch (err) {
      return {
        ...base,
        message: `OCR failed: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }

    if (!ocr.ok) {
      return { ...base, message: ocr.message ?? 'OCR failed.' }
    }
    if (ocr.text.trim().length < MIN_OCR_CHARS) {
      return {
        ...base,
        ocrLanguage: ocr.language,
        message: 'No readable text was found in that region. Try a larger area.'
      }
    }

    const original = ocr.text.trim()
    base.original = original
    base.ocrLanguage = ocr.language
    base.detectedLanguage = detectScript(original)

    const translated = await this.deps.translate(original, req.targetLanguage)
    base.translateProvider = translated.providerLabel
    if (!translated.ok) {
      return {
        ...base,
        partial: true,
        message: translated.message ?? 'The text was recognised but could not be translated.'
      }
    }
    const result: ScreenTranslationResult = {
      ...base,
      ok: true,
      translated: translated.text
    }
    this.entries = [result, ...this.entries].slice(0, MAX_TRANSLATION_HISTORY)
    return result
  }
}
