/**
 * Practice interview service (transformation Module K).
 *
 * Runs a COMPLETE mock interview against the active AI provider:
 * question generation (one at a time) → per-answer rubric evaluation →
 * final scorecard. Everything streams through the same AIProvider interface
 * used by interview/meeting modes and persists through the same SQLiteStore.
 *
 * Isolation: practice sessions NEVER touch the live context engine — a
 * practice question cannot read live transcripts, and practice answers are
 * stored only in the practice tables. Anti-fabrication is contractual: the
 * evaluation prompts may only credit what the candidate actually said.
 */
import {
  PracticeDifficulty,
  PracticeDimensionScore,
  PracticeDetail,
  PracticeFeedback,
  PracticeQuestionEvent,
  PracticeScorecard,
  PracticeSessionInfo,
  PracticeStartRequestSchema,
  PracticeType
} from '../../../shared/protocol'
import { AIProvider, ProviderError } from '../providers/types'
import {
  practiceEvaluationPrompt,
  practiceQuestionPrompt,
  practiceScorecardPrompt
} from '../modes/prompts'
import { PracticeSessionRecord, SQLiteStore } from '../context/sqlite-store'

export interface PracticeDeps {
  store: SQLiteStore
  resolveProvider: () => { provider: AIProvider; model: string } | null
  /** Facts of the active profile, for grounded behavioral follow-ups. */
  getProfileFacts: (profileId: string) => string[]
  getResponseLanguage: () => string
}

export interface PracticeEvents {
  onDelta(e: { practiceId: string; requestId: string; kind: 'question' | 'eval' | 'scorecard'; delta: string }): void
  onQuestion(e: PracticeQuestionEvent): void
  onEvaluated(e: { practiceId: string; index: number; feedback: PracticeFeedback }): void
  onFinished(e: { practiceId: string; scorecard: PracticeScorecard }): void
  onError(e: { practiceId: string; requestId: string; message: string }): void
}

const TIMEOUT_MS = 90_000
const MAX_FACT_CHARS = 2_000
const MAX_TURN_HISTORY_CHARS = 6_000

interface ActivePractice {
  practiceId: string
  type: PracticeType
  difficulty: PracticeDifficulty
  questionCount: number
  role: string
  customFocus: string
  jobDescription: string
  profileId: string
  abort: AbortController
}

/** Extract the outermost JSON object from a model response (fence-tolerant). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? Math.round(v) : Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(5, Math.max(1, n))
}

/** Validate a model-produced evaluation; null when unusable (caller retries/fails). */
export function parseFeedback(raw: string): PracticeFeedback | null {
  const obj = extractJsonObject(raw)
  if (!obj || !Array.isArray(obj['dimensions'])) return null
  const dimensions: PracticeDimensionScore[] = (obj['dimensions'] as Array<Record<string, unknown>>)
    .filter((d) => typeof d === 'object' && d !== null && typeof d['dimension'] === 'string')
    .slice(0, 6)
    .map((d) => ({
      dimension: String(d['dimension']),
      score: clampScore(d['score']),
      comment: String(d['comment'] ?? '')
    }))
  if (dimensions.length === 0) return null
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8) : []
  return {
    overall: clampScore(obj['overall'] ?? dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length),
    dimensions,
    strengths: strings(obj['strengths']),
    improvements: strings(obj['improvements']),
    improvedAnswer: typeof obj['improvedAnswer'] === 'string' ? obj['improvedAnswer'] : ''
  }
}

export function parseScorecard(raw: string): PracticeScorecard | null {
  const obj = extractJsonObject(raw)
  if (!obj) return null
  const summary = typeof obj['summary'] === 'string' ? obj['summary'] : ''
  if (summary.length === 0) return null
  const areas = Array.isArray(obj['areasForImprovement'])
    ? (obj['areasForImprovement'] as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8)
    : []
  return {
    overall: clampScore(obj['overall']),
    communication: clampScore(obj['communication']),
    technicalAccuracy: clampScore(obj['technicalAccuracy']),
    relevance: clampScore(obj['relevance']),
    completeness: clampScore(obj['completeness']),
    problemSolving: clampScore(obj['problemSolving']),
    summary,
    areasForImprovement: areas
  }
}

export class PracticeService {
  private events: PracticeEvents = {
    onDelta: () => undefined,
    onQuestion: () => undefined,
    onEvaluated: () => undefined,
    onFinished: () => undefined,
    onError: () => undefined
  }
  private active: ActivePractice | null = null

  constructor(private deps: PracticeDeps) {}

  bindEvents(events: PracticeEvents): void {
    this.events = events
  }

  get activePracticeId(): string | null {
    return this.active?.practiceId ?? null
  }

  /* ── start ──────────────────────────────────────────────────────────── */

  start(raw: unknown): { ok: true; practiceId: string } | { ok: false; message: string } {
    const parsed = PracticeStartRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid practice configuration' }
    if (!this.deps.resolveProvider()) {
      return { ok: false, message: 'No AI provider configured. Add one in Settings → Providers.' }
    }
    if (this.active) {
      return { ok: false, message: 'A practice interview is already running. Finish or cancel it first.' }
    }

    const cfg = parsed.data
    const practiceId = `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    this.deps.store.upsertPracticeSession({
      practiceId,
      type: cfg.type,
      difficulty: cfg.difficulty,
      questionCount: cfg.questionCount,
      status: 'active',
      role: cfg.role,
      jobDescription: cfg.jobDescription,
      scorecardJson: null,
      createdAt: now,
      updatedAt: now
    })
    this.active = {
      practiceId,
      type: cfg.type,
      difficulty: cfg.difficulty,
      questionCount: cfg.questionCount,
      role: cfg.role,
      customFocus: cfg.customFocus,
      jobDescription: cfg.jobDescription,
      profileId: cfg.profileId,
      abort: new AbortController()
    }
    void this.generateQuestion(practiceId, 1)
    return { ok: true, practiceId }
  }

  /* ── answers ────────────────────────────────────────────────────────── */

  submit(practiceId: string, answer: string, spoken: boolean): { ok: boolean; message?: string } {
    const a = this.requireActive(practiceId)
    if (!a) return { ok: false, message: 'No active practice interview with this id.' }
    const turns = this.deps.store.listPracticeTurns(practiceId)
    const turn = turns[turns.length - 1]
    if (!turn) return { ok: false, message: 'No question to answer yet.' }
    if (turn.answer.trim().length > 0) {
      return { ok: false, message: 'This question was already answered. Wait for the next one.' }
    }
    this.deps.store.updatePracticeTurnAnswer(practiceId, turn.index, answer.trim(), spoken)
    void this.evaluateAndContinue(a, turn.index, turn.question, answer.trim(), spoken)
    return { ok: true }
  }

  /** Finish early (or after the last evaluation): produce the scorecard. */
  end(practiceId: string): { ok: boolean; message?: string } {
    const record = this.deps.store.getPracticeSession(practiceId)
    if (!record) return { ok: false, message: 'Unknown practice session.' }
    if (record.status !== 'active') return { ok: false, message: 'This practice session already ended.' }
    void this.generateScorecard(practiceId, record)
    return { ok: true }
  }

  cancel(practiceId: string): { ok: boolean; message?: string } {
    const record = this.deps.store.getPracticeSession(practiceId)
    if (!record) return { ok: false, message: 'Unknown practice session.' }
    if (this.active?.practiceId === practiceId) {
      this.active.abort.abort()
      this.active = null
    }
    this.deps.store.updatePracticeStatus(practiceId, 'cancelled', null)
    return { ok: true }
  }

  /* ── queries ────────────────────────────────────────────────────────── */

  listSessions(): PracticeSessionInfo[] {
    return this.deps.store.listPracticeSessions().map((s) => {
      const info: PracticeSessionInfo = {
        practiceId: s.practiceId,
        type: s.type as PracticeType,
        difficulty: s.difficulty as PracticeDifficulty,
        questionCount: s.questionCount,
        status: s.status,
        role: s.role,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }
      if (s.scorecardJson) {
        const sc = safeParseScorecard(s.scorecardJson)
        if (sc) info.scorecard = sc
      }
      return info
    })
  }

  getDetail(practiceId: string): PracticeDetail | undefined {
    const s = this.deps.store.getPracticeSession(practiceId)
    if (!s) return undefined
    const base = this.listSessions().find((i) => i.practiceId === practiceId)!
    return {
      ...base,
      jobDescription: s.jobDescription,
      turns: this.deps.store.listPracticeTurns(practiceId).map((t) => ({
        index: t.index,
        question: t.question,
        answer: t.answer,
        feedback: t.feedbackJson ? safeParseFeedback(t.feedbackJson) ?? undefined : undefined,
        spoken: t.spoken
      }))
    }
  }

  deleteSession(practiceId: string): { ok: boolean } {
    if (this.active?.practiceId === practiceId) {
      this.active.abort.abort()
      this.active = null
    }
    return { ok: this.deps.store.deletePracticeSession(practiceId) }
  }

  /* ── question generation ────────────────────────────────────────────── */

  private async generateQuestion(practiceId: string, index: number): Promise<void> {
    const a = this.active
    if (!a || a.practiceId !== practiceId) return
    const resolved = this.deps.resolveProvider()
    if (!resolved) {
      this.failActive(practiceId, 'No AI provider configured.')
      return
    }
    const requestId = `pq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const facts = this.deps.getProfileFacts(a.profileId).join('\n- ')
    const system = practiceQuestionPrompt({
      type: a.type,
      difficulty: a.difficulty,
      role: a.customFocus ? (a.role ? `${a.role} — focus: ${a.customFocus}` : a.customFocus) : a.role,
      hasJobDescription: a.jobDescription.trim().length > 0,
      responseLanguage: this.deps.getResponseLanguage()
    })
    const user = [
      `This is question ${index} of ${a.questionCount} in the mock interview.`,
      a.jobDescription.trim().length > 0
        ? `Job description (authoritative for what to probe):\n${bounded(a.jobDescription.trim(), 8_000)}`
        : '',
      facts.length > 0
        ? `Candidate's own profile facts (background only — the candidate HAS stated these; do not invent beyond them):\n- ${bounded(facts, MAX_FACT_CHARS)}`
        : '',
      this.turnHistoryBlock(practiceId),
      index === 1
        ? 'Ask the first question now.'
        : 'The candidate answered the previous question (see above). Ask the next question now.'
    ]
      .filter((s) => s.length > 0)
      .join('\n\n')

    const question = await this.collect(
      practiceId,
      requestId,
      'question',
      resolved.provider,
      resolved.model,
      system,
      user,
      a.abort.signal
    )
    if (question === null) return // aborted or errored (already reported)
    const clean = cleanQuestion(question)
    if (clean.length === 0) {
      this.failActive(practiceId, 'The provider returned an empty question. Try again or switch models.')
      return
    }
    this.deps.store.upsertPracticeTurn(practiceId, {
      index,
      question: clean,
      answer: '',
      feedbackJson: null,
      spoken: false
    })
    this.events.onQuestion({ practiceId, index, question: clean })
  }

  private turnHistoryBlock(practiceId: string): string {
    const turns = this.deps.store.listPracticeTurns(practiceId)
    if (turns.length === 0) return ''
    const lines = turns.map((t) => {
      const feedback = t.feedbackJson ? safeParseFeedback(t.feedbackJson) : null
      return [
        `Q${t.index}: ${t.question}`,
        `A${t.index}: ${t.answer || '(no answer)'}`,
        feedback ? `Evaluation Q${t.index}: overall ${feedback.overall}/5. Improvements: ${feedback.improvements.join('; ') || '—'}` : ''
      ]
        .filter((l) => l.length > 0)
        .join('\n')
    })
    return bounded(`Interview so far:\n${lines.join('\n')}`, MAX_TURN_HISTORY_CHARS)
  }

  /* ── evaluation + continuation ──────────────────────────────────────── */

  private async evaluateAndContinue(
    a: ActivePractice,
    index: number,
    question: string,
    answer: string,
    spoken: boolean
  ): Promise<void> {
    const resolved = this.deps.resolveProvider()
    if (!resolved) {
      this.failActive(a.practiceId, 'No AI provider configured.')
      return
    }
    const requestId = `pe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const system = practiceEvaluationPrompt({
      type: a.type,
      question,
      answer,
      responseLanguage: this.deps.getResponseLanguage()
    })
    const user = `Question: ${question}\n\nCandidate's answer:\n${bounded(answer || '(the candidate gave no answer)', 20_000)}`

    const raw = await this.collect(
      a.practiceId,
      requestId,
      'eval',
      resolved.provider,
      resolved.model,
      system,
      user,
      a.abort.signal
    )
    if (raw === null) return
    const feedback = parseFeedback(raw)
    if (feedback === null) {
      this.events.onError({
        practiceId: a.practiceId,
        requestId,
        message: 'The evaluation response was not valid JSON. Try again or switch models.'
      })
      return
    }
    this.persistFeedback(a.practiceId, index, feedback, spoken)
    this.events.onEvaluated({ practiceId: a.practiceId, index, feedback })

    // Continue: next question, or straight to the scorecard after the last one.
    if (index >= a.questionCount) {
      const record = this.deps.store.getPracticeSession(a.practiceId)
      if (record && record.status === 'active') await this.generateScorecard(a.practiceId, record)
      return
    }
    await this.generateQuestion(a.practiceId, index + 1)
  }

  private persistFeedback(practiceId: string, index: number, feedback: PracticeFeedback, spoken: boolean): void {
    const turns = this.deps.store.listPracticeTurns(practiceId)
    const turn = turns.find((t) => t.index === index)
    if (!turn) return
    this.deps.store.upsertPracticeTurn(practiceId, {
      index,
      question: turn.question,
      answer: turn.answer,
      feedbackJson: JSON.stringify(feedback),
      spoken
    })
  }

  /* ── scorecard ──────────────────────────────────────────────────────── */

  private async generateScorecard(practiceId: string, record: PracticeSessionRecord): Promise<void> {
    const resolved = this.deps.resolveProvider()
    if (!resolved) {
      this.failActive(practiceId, 'No AI provider configured.')
      return
    }
    const requestId = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const system = practiceScorecardPrompt({ type: record.type, responseLanguage: this.deps.getResponseLanguage() })
    const turns = this.deps.store.listPracticeTurns(practiceId)
    if (turns.length === 0) {
      // Nothing to score: close the session without a scorecard.
      this.deps.store.updatePracticeStatus(practiceId, 'cancelled', null)
      if (this.active?.practiceId === practiceId) this.active = null
      this.events.onError({
        practiceId,
        requestId,
        message: 'No answers were submitted — nothing to score. The session was closed.'
      })
      return
    }
    const user = turns
      .map((t) => {
        const feedback = t.feedbackJson ? safeParseFeedback(t.feedbackJson) : null
        return [
          `Q${t.index}: ${t.question}`,
          `A${t.index}: ${bounded(t.answer || '(no answer)', 4_000)}`,
          feedback ? `Evaluation: overall ${feedback.overall}/5; ${feedback.dimensions.map((d) => `${d.dimension} ${d.score}/5`).join(', ')}` : '(not evaluated)'
        ].join('\n')
      })
      .join('\n\n')

    const raw = await this.collect(
      practiceId,
      requestId,
      'scorecard',
      resolved.provider,
      resolved.model,
      system,
      bounded(user, 40_000),
      this.active?.practiceId === practiceId ? this.active.abort.signal : new AbortController().signal
    )
    if (raw === null) return
    const scorecard = parseScorecard(raw)
    if (scorecard === null) {
      this.events.onError({
        practiceId,
        requestId,
        message: 'The scorecard response was not valid JSON. Try again or switch models.'
      })
      return
    }
    this.deps.store.updatePracticeStatus(practiceId, 'completed', JSON.stringify(scorecard))
    if (this.active?.practiceId === practiceId) this.active = null
    this.events.onFinished({ practiceId, scorecard })
  }

  /* ── shared streaming ───────────────────────────────────────────────── */

  /** Streams one completion; returns the text, or null on abort/error (reported). */
  private async collect(
    practiceId: string,
    requestId: string,
    kind: 'question' | 'eval' | 'scorecard',
    provider: AIProvider,
    model: string,
    system: string,
    user: string,
    signal: AbortSignal
  ): Promise<string | null> {
    let text = ''
    try {
      for await (const chunk of provider.chatStream({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        signal,
        timeoutMs: TIMEOUT_MS
      })) {
        if (chunk.type === 'delta') {
          text += chunk.text
          this.events.onDelta({ practiceId, requestId, kind, delta: chunk.text })
        }
      }
      return text
    } catch (err) {
      if (!signal.aborted) {
        const message =
          err instanceof ProviderError ? err.message : 'Generation failed. Check the provider in Settings.'
        this.events.onError({ practiceId, requestId, message })
      }
      return null
    }
  }

  private failActive(practiceId: string, message: string): void {
    this.events.onError({ practiceId, requestId: `pf-${Date.now().toString(36)}`, message })
  }

  private requireActive(practiceId: string): ActivePractice | null {
    return this.active && this.active.practiceId === practiceId ? this.active : null
  }
}

function cleanQuestion(text: string): string {
  // Models sometimes add "Question N:" prefixes or trailing offers; strip them.
  return text
    .replace(/^\s*(question\s*\d+\s*[:.)-]\s*)/i, '')
    .replace(/\n+$/, '')
    .trim()
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…(truncated)'
}

function safeParseFeedback(json: string): PracticeFeedback | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'overall' in parsed) {
      return parsed as PracticeFeedback
    }
    return null
  } catch {
    return null
  }
}

function safeParseScorecard(json: string): PracticeScorecard | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'overall' in parsed && 'summary' in parsed) {
      return parsed as PracticeScorecard
    }
    return null
  } catch {
    return null
  }
}
