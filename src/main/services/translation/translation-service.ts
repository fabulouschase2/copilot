/**
 * Live translation engine (Phase 4).
 *
 * Independent from interview answer generation: it consumes finalized
 * transcript segments from a `translation`-purpose session and emits one
 * translated line per segment. It names the provider on every result, keeps
 * the queue bounded (live captions must not grow without bound), and never
 * fabricates a translation when the provider fails.
 *
 * Design decisions:
 * - Translation runs on the active chat provider, so switching providers takes
 *   effect on the next line without restarting the session.
 * - Serial queue: order is preserved even if a provider responds slowly.
 * - A bounded backlog drops the oldest pending lines and reports the count
 *   rather than translating minutes-old captions.
 */
import { TranslationResultEvent, TranslationSettings } from '../../../shared/protocol'
import { languageLabel, languageNative } from '../../../shared/languages'
import { AIProvider, ProviderError } from '../providers/types'

const MAX_BACKLOG = 4
const TRANSLATE_TIMEOUT_MS = 25_000
const MAX_TOKENS = 700

export interface TranslationSegment {
  sessionId: string
  segmentId: string
  text: string
  sourceLanguage?: string
}

export interface TranslationDeps {
  resolveProvider: () => { provider: AIProvider; model: string } | null
  getSettings: () => TranslationSettings
  now?: () => Date
}

export interface TranslationEvents {
  onResult: (event: TranslationResultEvent) => void
  onError: (event: { sessionId: string; segmentId: string; message: string }) => void
}

export interface TranslateOutcome {
  ok: boolean
  text: string
  providerLabel: string
  message?: string
}

/** Prompt contract: translate only, never explain, never answer the text. */
export function buildTranslationSystemPrompt(target: string, source?: string): string {
  const targetName = languageLabel(target)
  const targetNative = languageNative(target)
  const sourceLine = source && source !== 'auto' ? `The source language is ${languageLabel(source)}. ` : ''
  return [
    `You are a professional simultaneous interpreter. Translate the user's text into ${targetName} (${targetNative}).`,
    sourceLine,
    'Rules:',
    '- Output only the translation. No preamble, no notes, no quotes around it, no explanation.',
    '- Preserve meaning, tone, names, numbers and technical terms. Do not summarize or expand.',
    '- If the text is already in the target language, return it unchanged.',
    '- If the text is unintelligible, return an empty string.'
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Small models like to wrap answers in quotes or prefix "Translation:".
 * Strip only clearly mechanical wrappers — never rewrite content.
 */
export function sanitizeTranslation(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^(translation|translated text|output)\s*:\s*/i, '').trim()
  if (text.length >= 2 && /^["“].*["”]$/s.test(text)) {
    text = text.slice(1, -1).trim()
  }
  if (text.length >= 2 && /^'.*'$/s.test(text)) {
    text = text.slice(1, -1).trim()
  }
  return text
}

export class TranslationService {
  private queue: TranslationSegment[] = []
  private busy = false
  private controller: AbortController | null = null
  private sessionId: string | null = null
  private dropped = 0
  private translated = 0
  private failed = 0
  private events: TranslationEvents = {
    onResult: () => undefined,
    onError: () => undefined
  }

  constructor(private readonly deps: TranslationDeps) {}

  /** The IPC layer binds these once at startup, same pattern as other services. */
  bindEvents(events: TranslationEvents): void {
    this.events = events
  }

  /** Feed one finalized utterance. No-op unless the user enabled translation. */
  observeSegment(segment: TranslationSegment): void {
    if (!this.deps.getSettings().enabled) return
    const text = segment.text.trim()
    if (text.length === 0) return
    if (this.sessionId !== segment.sessionId) {
      this.reset(segment.sessionId)
    }
    this.queue.push({ ...segment, text })
    while (this.queue.length > MAX_BACKLOG) {
      this.queue.shift()
      this.dropped += 1
    }
    void this.pump()
  }

  /** End-of-session cleanup; aborts any in-flight translation. */
  reset(sessionId: string | null = null): void {
    this.queue = []
    this.controller?.abort()
    this.controller = null
    this.sessionId = sessionId
  }

  stats(): { queued: number; dropped: number; translated: number; failed: number } {
    return {
      queued: this.queue.length,
      dropped: this.dropped,
      translated: this.translated,
      failed: this.failed
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (!item) break
        await this.runOne(item)
      }
    } finally {
      this.busy = false
    }
  }

  private async runOne(item: TranslationSegment): Promise<void> {
    const outcome = await this.translate(item.text, item.sourceLanguage)
    if (outcome.ok) {
      this.translated += 1
      this.events.onResult({
        sessionId: item.sessionId,
        segmentId: item.segmentId,
        original: item.text,
        translated: outcome.text,
        targetLanguage: this.deps.getSettings().targetLanguage,
        providerLabel: outcome.providerLabel,
        at: (this.deps.now?.() ?? new Date()).toISOString()
      })
      return
    }
    this.failed += 1
    this.events.onError({ sessionId: item.sessionId, segmentId: item.segmentId, message: outcome.message ?? 'Translation failed' })
  }

  /**
   * Translate one string. Public so the UI can translate a pasted line and the
   * self-test can exercise the real provider without a microphone.
   */
  async translate(text: string, sourceLanguage?: string): Promise<TranslateOutcome> {
    const controller = new AbortController()
    this.controller?.abort()
    this.controller = controller
    const timeout = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
    const signal = AbortSignal.any([controller.signal, timeout])
    try {
      return await this.request(text, sourceLanguage, signal)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  /**
   * One-off translation for a manual check. Never aborts live captions, so the
   * "Test translation" button cannot disturb a running session.
   */
  async translateDetached(
    text: string,
    sourceLanguage?: string,
    targetOverride?: string
  ): Promise<TranslateOutcome> {
    const timeout = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
    return this.request(text, sourceLanguage, timeout, targetOverride)
  }

  private async request(
    text: string,
    sourceLanguage: string | undefined,
    signal: AbortSignal,
    targetOverride?: string
  ): Promise<TranslateOutcome> {
    const resolved = this.deps.resolveProvider()
    if (!resolved) {
      return {
        ok: false,
        text: '',
        providerLabel: 'none',
        message: 'No AI provider is configured. Add one in Settings → Providers.'
      }
    }
    const target = targetOverride ?? this.deps.getSettings().targetLanguage

    let raw = ''
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages: [
          { role: 'system', content: buildTranslationSystemPrompt(target, sourceLanguage) },
          { role: 'user', content: text }
        ],
        signal,
        timeoutMs: TRANSLATE_TIMEOUT_MS,
        maxTokens: MAX_TOKENS
      })) {
        if (chunk.type === 'delta') raw += chunk.text
      }
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The translation request failed.'
      return { ok: false, text: '', providerLabel: resolved.provider.label, message }
    }

    const clean = sanitizeTranslation(raw)
    if (clean.length === 0) {
      return {
        ok: false,
        text: '',
        providerLabel: resolved.provider.label,
        message: 'The provider returned an empty translation.'
      }
    }
    return { ok: true, text: clean, providerLabel: resolved.provider.label }
  }
}
