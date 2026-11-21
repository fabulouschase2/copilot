/**
 * 0.4.0 screen translation: OCR output handling and the capture→OCR→translate flow.
 *
 * The service must never report success unless both steps produced text, and a
 * translation failure must not discard what OCR already read.
 */
import { describe, expect, it } from 'vitest'
import { ScreenTranslateRequestSchema } from '../src/shared/protocol'
import { parseOcrOutput, ocrImageFile } from '../src/main/services/screen/local-ocr'
import {
  MAX_TRANSLATION_HISTORY,
  ScreenTranslationService,
  detectScript
} from '../src/main/services/screen/screen-translation'

describe('OCR output parsing', () => {
  it('reads the success payload', () => {
    const out = parseOcrOutput(
      'noise line\n{"ok":true,"text":"Hello world","lines":["Hello world","Second"],"language":"en-US"}\n'
    )
    expect(out.ok).toBe(true)
    expect(out.text).toBe('Hello world')
    expect(out.lines).toEqual(['Hello world', 'Second'])
    expect(out.language).toBe('en-US')
  })

  it('passes the engine error through', () => {
    const out = parseOcrOutput('{"ok":false,"error":"No Windows OCR language pack is installed."}')
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/language pack/i)
  })

  it('fails cleanly on unusable output', () => {
    expect(parseOcrOutput('').ok).toBe(false)
    expect(parseOcrOutput('powershell error text').ok).toBe(false)
    expect(parseOcrOutput('{broken').ok).toBe(false)
  })

  it('drops empty lines and trims text', () => {
    const out = parseOcrOutput('{"ok":true,"text":"  hi  ","lines":[" hi ","","   "],"language":"en-US"}')
    expect(out.text).toBe('hi')
    expect(out.lines).toEqual(['hi'])
  })
})

describe('ocrImageFile guards', () => {
  it('refuses a missing file without throwing', async () => {
    const res = await ocrImageFile('C:\\definitely\\not\\here.png')
    expect(res.ok).toBe(false)
    expect(res.message).toBeTruthy()
  })
})

describe('script detection (label only)', () => {
  it('labels common scripts', () => {
    expect(detectScript('hello there')).toBe('Latin')
    expect(detectScript('こんにちは')).toBe('Japanese')
    expect(detectScript('안녕하세요')).toBe('Korean')
    expect(detectScript('你好世界')).toBe('Chinese')
    expect(detectScript('مرحبا')).toBe('Arabic')
    expect(detectScript('Привет')).toBe('Cyrillic')
    expect(detectScript('')).toBeNull()
  })
})

function harness(opts: {
  ocrText?: string
  ocrOk?: boolean
  translateOk?: boolean
  captureThrows?: boolean
}) {
  const state = { captures: 0, translations: [] as string[] }
  const service = new ScreenTranslationService({
    capture: async () => {
      state.captures += 1
      if (opts.captureThrows) throw new Error('capture failed')
      return { jpegBase64: Buffer.from('fake-jpeg').toString('base64'), width: 800, height: 600 }
    },
    ocr: async () => ({
      ok: opts.ocrOk ?? true,
      text: opts.ocrText ?? 'Good morning, the meeting starts at nine.',
      lines: (opts.ocrText ?? 'Good morning, the meeting starts at nine.').split('\n'),
      language: 'en-US'
    }),
    translate: async (text, target) => {
      state.translations.push(`${text}->${target}`)
      return opts.translateOk === false
        ? { ok: false, text: '', providerLabel: 'Fake Provider', message: 'Rate limited by provider (429)' }
        : { ok: true, text: 'Buenos días, la reunión empieza a las nueve.', providerLabel: 'Fake Provider' }
    },
    now: () => new Date('2026-03-01T10:00:00.000Z'),
    idFactory: () => 'str-test'
  })
  return { service, state }
}

describe('ScreenTranslationService', () => {
  it('returns original and translated text with both providers named', async () => {
    const { service, state } = harness({})
    const res = await service.translateRegion({ targetLanguage: 'es' })
    expect(res.ok).toBe(true)
    expect(res.original).toContain('Good morning')
    expect(res.translated).toContain('Buenos días')
    expect(res.ocrProvider).toBe('Windows OCR')
    expect(res.translateProvider).toBe('Fake Provider')
    expect(res.targetLanguage).toBe('es')
    expect(res.detectedLanguage).toBe('Latin')
    expect(res.ocrLanguage).toBe('en-US')
    expect(state.captures).toBe(1)
    expect(service.list()).toHaveLength(1)
  })

  it('reports an empty OCR result instead of a blank success', async () => {
    const { service } = harness({ ocrText: '' })
    const res = await service.translateRegion({ targetLanguage: 'fr' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/No readable text/i)
    expect(service.list()).toHaveLength(0)
  })

  it('keeps the recognised text when translation fails', async () => {
    const { service } = harness({ translateOk: false })
    const res = await service.translateRegion({ targetLanguage: 'de' })
    expect(res.ok).toBe(false)
    expect(res.partial).toBe(true)
    expect(res.original).toContain('Good morning')
    expect(res.message).toContain('429')
    expect(service.list()).toHaveLength(0)
  })

  it('reports capture failures without calling OCR', async () => {
    const { service, state } = harness({ captureThrows: true })
    const res = await service.translateRegion({ targetLanguage: 'es' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/Could not capture/i)
    expect(state.translations).toHaveLength(0)
  })

  it('caps history and keeps the newest first', async () => {
    const { service } = harness({})
    for (let i = 0; i < MAX_TRANSLATION_HISTORY + 3; i += 1) {
      await service.translateRegion({ targetLanguage: 'es' })
    }
    const list = service.list()
    expect(list).toHaveLength(MAX_TRANSLATION_HISTORY)
    expect(list[0].id).toBe('str-test')
    service.clear()
    expect(service.list()).toHaveLength(0)
  })
})

describe('request schema', () => {
  it('accepts an empty request (whole screen, default language)', () => {
    expect(ScreenTranslateRequestSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a normalized region', () => {
    const parsed = ScreenTranslateRequestSchema.safeParse({
      region: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
      targetLanguage: 'ja'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects out-of-range regions and bad language codes', () => {
    expect(ScreenTranslateRequestSchema.safeParse({ region: { x: 1.5, y: 0, w: 0.2, h: 0.2 } }).success).toBe(false)
    expect(ScreenTranslateRequestSchema.safeParse({ targetLanguage: 'x' }).success).toBe(false)
    expect(ScreenTranslateRequestSchema.safeParse({ sourceId: '' }).success).toBe(false)
  })
})
