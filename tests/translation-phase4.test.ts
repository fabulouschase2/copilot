/**
 * Phase 4 — live translation engine tests.
 *
 * These pin the behaviours that matter for honesty and stability:
 *  - the prompt forbids commentary and answers;
 *  - mechanical wrappers are stripped, real content is not rewritten;
 *  - a provider failure becomes a visible error, never an empty caption;
 *  - the queue is bounded so live captions cannot grow without bound.
 */
import { describe, expect, it } from 'vitest'
import { AppSettingsSchema } from '../src/shared/protocol'
import {
  buildTranslationSystemPrompt,
  sanitizeTranslation,
  TranslationService
} from '../src/main/services/translation/translation-service'
import type { AIProvider, ChatStreamRequest } from '../src/main/services/providers/types'
import { ProviderError } from '../src/main/services/providers/types'

function fakeProvider(
  chunks: string[],
  opts: { error?: Error; gate?: Promise<void> } = {}
): AIProvider {
  return {
    id: 'fake',
    label: 'Fake Provider',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream(_req: ChatStreamRequest) {
      if (opts.gate) await opts.gate
      if (opts.error) throw opts.error
      for (const text of chunks) yield { type: 'delta' as const, text }
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 1 }
    }
  }
}

const enabledSettings = {
  enabled: true,
  targetLanguage: 'es',
  showOriginal: true,
  fontSize: 15
}

describe('translation prompt contract', () => {
  it('names the target language and forbids commentary', () => {
    const prompt = buildTranslationSystemPrompt('es')
    expect(prompt).toContain('Spanish')
    expect(prompt).toContain('Español')
    expect(prompt).toMatch(/Output only the translation/i)
    expect(prompt).toMatch(/No preamble/i)
  })

  it('states the source language when it is known', () => {
    expect(buildTranslationSystemPrompt('fr', 'en')).toContain('source language is English')
    expect(buildTranslationSystemPrompt('fr', 'auto')).not.toContain('source language is')
  })
})

describe('translation output sanitising', () => {
  it('strips mechanical prefixes a small model may add', () => {
    expect(sanitizeTranslation('Translation: Buenos días')).toBe('Buenos días')
    expect(sanitizeTranslation('  Output: hola  ')).toBe('hola')
  })

  it('strips wrapping quotes only', () => {
    expect(sanitizeTranslation('"Buenos días"')).toBe('Buenos días')
    expect(sanitizeTranslation('“Buenos días”')).toBe('Buenos días')
    expect(sanitizeTranslation("'hola'")).toBe('hola')
  })

  it('never rewrites content inside the line', () => {
    expect(sanitizeTranslation('He said "hello" twice')).toBe('He said "hello" twice')
    expect(sanitizeTranslation('40 % faster')).toBe('40 % faster')
  })
})

describe('TranslationService', () => {
  it('translates through the active provider and reports which one', async () => {
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['Buenos', ' días']), model: 'm' }),
      getSettings: () => enabledSettings
    })
    const result = await service.translate('Good morning')
    expect(result.ok).toBe(true)
    expect(result.text).toBe('Buenos días')
    expect(result.providerLabel).toBe('Fake Provider')
  })

  it('fails loudly when no provider is configured', async () => {
    const service = new TranslationService({
      resolveProvider: () => null,
      getSettings: () => enabledSettings
    })
    const result = await service.translate('Good morning')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/No AI provider/)
  })

  it('surfaces provider errors verbatim instead of an empty caption', async () => {
    const service = new TranslationService({
      resolveProvider: () => ({
        provider: fakeProvider([], { error: new ProviderError('Rate limited by provider (429)', 429) }),
        model: 'm'
      }),
      getSettings: () => enabledSettings
    })
    const result = await service.translate('Hello')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('429')
  })

  it('treats an empty provider response as a failure', async () => {
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['   ']), model: 'm' }),
      getSettings: () => enabledSettings
    })
    const result = await service.translate('Hello')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/empty translation/i)
  })
})

describe('live segment pipeline', () => {
  it('ignores segments while translation is disabled', async () => {
    const events: unknown[] = []
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['hola']), model: 'm' }),
      getSettings: () => ({ ...enabledSettings, enabled: false })
    })
    service.bindEvents({ onResult: (e) => events.push(e), onError: (e) => events.push(e) })
    service.observeSegment({ sessionId: 's1', segmentId: 'a', text: 'hello' })
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toHaveLength(0)
  })

  it('emits one result per segment with the target language attached', async () => {
    const results: Array<Record<string, unknown>> = []
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['hola']), model: 'm' }),
      getSettings: () => enabledSettings
    })
    service.bindEvents({
      onResult: (e) => results.push({ ...e }),
      onError: () => undefined
    })
    service.observeSegment({ sessionId: 's1', segmentId: 'seg-1', text: 'hello' })
    const deadline = Date.now() + 2_000
    while (results.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(results).toHaveLength(1)
    expect(results[0]['translated']).toBe('hola')
    expect(results[0]['targetLanguage']).toBe('es')
    expect(results[0]['providerLabel']).toBe('Fake Provider')
    expect(results[0]['original']).toBe('hello')
  })

  it('bounds the backlog and counts dropped lines while the provider is slow', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['x'], { gate }), model: 'm' }),
      getSettings: () => enabledSettings
    })
    service.bindEvents({ onResult: () => undefined, onError: () => undefined })
    for (let i = 0; i < 10; i += 1) {
      service.observeSegment({ sessionId: 's1', segmentId: `seg-${i}`, text: `line ${i}` })
    }
    // One line is in flight; the queue must not exceed the bound.
    expect(service.stats().queued).toBeLessThanOrEqual(4)
    expect(service.stats().dropped).toBeGreaterThan(0)
    release()
    service.reset(null)
  })

  it('starts a fresh queue when the session changes', async () => {
    const service = new TranslationService({
      resolveProvider: () => ({ provider: fakeProvider(['a']), model: 'm' }),
      getSettings: () => enabledSettings
    })
    service.bindEvents({ onResult: () => undefined, onError: () => undefined })
    service.observeSegment({ sessionId: 'one', segmentId: 'a', text: 'first' })
    service.observeSegment({ sessionId: 'two', segmentId: 'b', text: 'second' })
    expect(service.stats().queued).toBeLessThanOrEqual(1)
    service.reset(null)
  })
})

describe('translation settings contract', () => {
  it('defaults off with Spanish selected', () => {
    const settings = AppSettingsSchema.parse({})
    expect(settings.translation).toEqual({
      enabled: false,
      targetLanguage: 'es',
      showOriginal: true,
      fontSize: 15
    })
  })

  it('rejects impossible caption sizes and language codes', () => {
    expect(AppSettingsSchema.safeParse({ translation: { targetLanguage: 'e' } }).success).toBe(false)
    expect(AppSettingsSchema.safeParse({ translation: { fontSize: 100 } }).success).toBe(false)
    expect(AppSettingsSchema.safeParse({ translation: { fontSize: 16 } }).success).toBe(true)
  })
})
