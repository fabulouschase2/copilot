/**
 * Interview & Meeting modes (Modules E/F, Stage 8).
 *
 * A thin orchestration layer over the EXISTING infrastructure: it resolves
 * providers through the same ProviderRegistry, retrieves through the same
 * ContextService (same session boundaries, budgets, exclusions), and streams
 * through the same AIProvider interface. One generation slot per channel;
 * nothing runs until the user explicitly triggers it. No auto-speak, no
 * auto-typing, no answer delivery beyond this window.
 */
import { ContextOptions } from '../../../shared/protocol'
import { AIProvider, ProviderError } from '../providers/types'
import { RetrievalResult } from '../context/context-service'
import { ModeQuestion } from '../../../shared/protocol'
import { dedupeQuestions, detectQuestions } from './question-detection'
import {
  interviewSystemPrompt,
  meetingActionsPrompt,
  meetingAskPrompt,
  meetingSummaryPrompt,
  refinePrompt,
  renderModeContextBlock
} from './prompts'

export interface ModeDeps {
  resolveProvider: () => { provider: AIProvider; model: string } | null
  retrieve: (question: string, options: ContextOptions) => RetrievalResult
  getSessionId: () => string | null
  /** User-initiated save; implemented with dialog+fs in main wiring. */
  saveText: (defaultName: string, content: string) => Promise<{ ok: boolean; canceled?: boolean; message?: string }>
}

export interface ModeEvents {
  onDelta(channel: 'interview' | 'meeting', requestId: string, delta: string): void
  onResult(result: {
    channel: 'interview' | 'meeting'
    requestId: string
    status: 'completed' | 'cancelled' | 'error'
    text: string
    evidenceLevel?: 'none' | 'partial' | 'good'
    contextUsed: Array<{ sourceId: string; displayName: string; type: string; score: number }>
    message?: string
  }): void
  onError(channel: 'interview' | 'meeting', requestId: string, message: string): void
  onQuestion(question: ModeQuestion): void
}

const MAX_QUESTIONS = 20
const TIMEOUT_MS = 90_000

interface Generation {
  id: string
  abort: AbortController
}

export class ModesService {
  private events: ModeEvents = {
    onDelta: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onQuestion: () => undefined
  }
  private slots = new Map<'interview' | 'meeting', Generation>()
  private questions: ModeQuestion[] = []
  private seenKeys = new Set<string>()

  constructor(private deps: ModeDeps) {}

  bindEvents(events: ModeEvents): void {
    this.events = events
  }

  /* ── session lifecycle (wired alongside ContextService) ─────────────── */

  beginSession(sessionId: string): void {
    // A new session starts with a clean question feed.
    this.questions = []
    this.seenKeys.clear()
    void sessionId
  }

  endSession(): void {
    this.questions = []
    this.seenKeys.clear()
  }

  get questionFeed(): readonly ModeQuestion[] {
    return this.questions
  }

  /**
   * Feed a finalized transcript segment; detected questions join the current
   * session's feed. Segments from other sessions are ignored.
   */
  observeTranscriptSegment(sessionId: string, text: string): ModeQuestion[] {
    if (sessionId !== this.deps.getSessionId()) return []
    const detected = dedupeQuestions(detectQuestions(text), this.seenKeys)
    const created: ModeQuestion[] = []
    for (const q of detected) {
      const entry: ModeQuestion = {
        id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        text: q.text,
        confidence: q.confidence,
        kind: q.kind,
        detectedAt: new Date().toISOString(),
        sessionId
      }
      created.push(entry)
      this.questions.unshift(entry)
      this.events.onQuestion(entry)
    }
    if (this.questions.length > MAX_QUESTIONS) this.questions.length = MAX_QUESTIONS
    return created
  }

  /* ── interview ──────────────────────────────────────────────────────── */

  interviewAnswer(req: {
    question: string
    style: 'concise' | 'detailed' | 'technical' | 'star' | 'coding' | 'research'
    includeSession: boolean
  }): { ok: true; requestId: string } | { ok: false; message: string } {
    const resolved = this.deps.resolveProvider()
    if (!resolved) return { ok: false, message: 'No AI provider configured. Add one in Settings.' }
    if (this.slots.has('interview')) {
      return { ok: false, message: 'An interview answer is already generating. Stop it first.' }
    }
    const requestId = `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const abort = new AbortController()
    this.slots.set('interview', { id: requestId, abort })

    const retrieval = this.deps.retrieve(req.question, {
      includeDocuments: true,
      includeProfile: true,
      includeSession: req.includeSession
    })
    const evidenceLevel = assessEvidence(retrieval)
    const system = interviewSystemPrompt(req.style, evidenceLevel)
    const user =
      `Question: ${req.question}\n\n${renderModeContextBlock(retrieval.items)}` +
      (evidenceLevel === 'none'
        ? '\n\n(No supporting evidence was found in the user\'s context — follow the missing-details rule.)'
        : '')

    void this.stream('interview', requestId, resolved.provider, resolved.model, system, user, abort, {
      evidenceLevel,
      contextUsed: retrieval.items
    })
    return { ok: true, requestId }
  }

  /* ── meeting ────────────────────────────────────────────────────────── */

  meetingGenerate(req: {
    kind: 'summary' | 'actions'
    includeDocuments: boolean
    includeProfile: boolean
  }): { ok: true; requestId: string } | { ok: false; message: string } {
    const resolved = this.deps.resolveProvider()
    if (!resolved) return { ok: false, message: 'No AI provider configured. Add one in Settings.' }
    if (this.slots.has('meeting')) {
      return { ok: false, message: 'A meeting generation is already running. Stop it first.' }
    }
    if (!this.deps.getSessionId() && !req.includeDocuments && !req.includeProfile) {
      return { ok: false, message: 'No active meeting session. Start transcription first (or explicitly include saved sources).' }
    }

    const question =
      req.kind === 'summary'
        ? 'Summarize this meeting: topics, decisions, action items with owners and deadlines.'
        : 'List every action item from this meeting with owners and deadlines.'
    const retrieval = this.deps.retrieve(question, {
      includeSession: true,
      includeDocuments: req.includeDocuments,
      includeProfile: req.includeProfile
    })
    if (retrieval.items.length === 0) {
      return { ok: false, message: 'Nothing to summarize yet — the current session has no captured conversation.' }
    }

    const requestId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const abort = new AbortController()
    this.slots.set('meeting', { id: requestId, abort })
    const system = req.kind === 'summary' ? meetingSummaryPrompt() : meetingActionsPrompt()
    const user = renderModeContextBlock(retrieval.items)

    void this.stream('meeting', requestId, resolved.provider, resolved.model, system, user, abort, {
      contextUsed: retrieval.items
    })
    return { ok: true, requestId }
  }

  meetingAsk(req: { question: string }): { ok: true; requestId: string } | { ok: false; message: string } {
    const resolved = this.deps.resolveProvider()
    if (!resolved) return { ok: false, message: 'No AI provider configured. Add one in Settings.' }
    if (this.slots.has('meeting')) {
      return { ok: false, message: 'A meeting generation is already running. Stop it first.' }
    }
    if (!this.deps.getSessionId()) {
      return { ok: false, message: 'No active meeting session. Start transcription first.' }
    }
    const requestId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const abort = new AbortController()
    this.slots.set('meeting', { id: requestId, abort })

    // Meeting Q&A is strictly current-session: no documents, no profile.
    const retrieval = this.deps.retrieve(req.question, {
      includeSession: true,
      includeDocuments: false,
      includeProfile: false
    })
    const user = `${req.question}\n\n${renderModeContextBlock(retrieval.items)}`
    void this.stream('meeting', requestId, resolved.provider, resolved.model, meetingAskPrompt(), user, abort, {
      contextUsed: retrieval.items
    })
    return { ok: true, requestId }
  }

  /**
   * Refine the previous interview answer (shorter / rephrased). Reuses the
   * interview slot and provider; no new retrieval — it refines what exists.
   */
  interviewRefine(req: {
    kind: 'shorter' | 'rephrase'
    question: string
    previousAnswer: string
  }): { ok: true; requestId: string } | { ok: false; message: string } {
    const resolved = this.deps.resolveProvider()
    if (!resolved) return { ok: false, message: 'No AI provider configured. Add one in Settings.' }
    if (this.slots.has('interview')) {
      return { ok: false, message: 'An interview answer is already generating. Stop it first.' }
    }
    const requestId = `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const abort = new AbortController()
    this.slots.set('interview', { id: requestId, abort })

    const system = refinePrompt(req.kind)
    const user = `Question: ${req.question}\n\nCurrent answer:\n${req.previousAnswer}\n\nRewrite it now.`
    void this.stream('interview', requestId, resolved.provider, resolved.model, system, user, abort, {
      contextUsed: []
    })
    return { ok: true, requestId }
  }

  cancel(channel: 'interview' | 'meeting'): void {
    this.slots.get(channel)?.abort.abort()
  }

  /* ── export ─────────────────────────────────────────────────────────── */

  async exportNotes(content: string, format: 'markdown' | 'txt'): Promise<{ ok: boolean; canceled?: boolean; message?: string }> {
    if (content.trim().length === 0) return { ok: false, message: 'Nothing to export yet.' }
    const defaultName = format === 'markdown' ? 'meeting-notes.md' : 'meeting-notes.txt'
    return this.deps.saveText(defaultName, content)
  }

  /* ── shared streaming ───────────────────────────────────────────────── */

  private async stream(
    channel: 'interview' | 'meeting',
    requestId: string,
    provider: AIProvider,
    model: string,
    system: string,
    user: string,
    abort: AbortController,
    meta: {
      evidenceLevel?: 'none' | 'partial' | 'good'
      contextUsed: Array<{ sourceId: string; displayName: string; type: string; score: number }>
    }
  ): Promise<void> {
    let text = ''
    try {
      // Gemini 3.x on the OpenAI-compat endpoint intermittently returns a
      // complete stream with reasoning metadata but zero visible content
      // (measured ~25% on the free tier). Bounded to ONE silent retry —
      // the first attempt emitted no deltas, so no duplicate text is shown.
      for (let attempt = 1; attempt <= 2; attempt++) {
        text = ''
        for await (const chunk of provider.chatStream({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          signal: abort.signal,
          timeoutMs: TIMEOUT_MS
          // No maxTokens cap: reasoning models spend the budget on hidden
          // reasoning first, so a small cap yields empty visible text.
        })) {
          if (chunk.type === 'delta') {
            text += chunk.text
            this.events.onDelta(channel, requestId, chunk.text)
          }
        }
        if (text.trim().length > 0) break
        if (attempt === 1 && !abort.signal.aborted) continue
      }
      if (text.trim().length === 0) {
        this.events.onError(
          channel,
          requestId,
          'The provider returned an empty response (its reasoning consumed the output). Try again or switch to a different model.'
        )
        this.events.onResult({
          channel,
          requestId,
          status: 'error',
          text: '',
          evidenceLevel: meta.evidenceLevel,
          contextUsed: meta.contextUsed,
          message: 'Empty provider response after one retry'
        })
        return
      }
      this.events.onResult({
        channel,
        requestId,
        status: 'completed',
        text,
        evidenceLevel: meta.evidenceLevel,
        contextUsed: meta.contextUsed
      })
    } catch (err) {
      if (abort.signal.aborted) {
        this.events.onResult({ channel, requestId, status: 'cancelled', text, contextUsed: meta.contextUsed })
      } else {
        const message = err instanceof ProviderError ? err.message : 'Generation failed.'
        this.events.onError(channel, requestId, message)
        this.events.onResult({ channel, requestId, status: 'error', text, contextUsed: meta.contextUsed, message })
      }
    } finally {
      this.slots.delete(channel)
    }
  }
}

/** Deterministic evidence assessment for interview answers. */
export function assessEvidence(retrieval: RetrievalResult): 'none' | 'partial' | 'good' {
  if (retrieval.items.length === 0) return 'none'
  const best = Math.max(...retrieval.items.map((i) => i.score))
  return best >= 0.45 ? 'good' : 'partial'
}
