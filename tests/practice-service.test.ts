import { describe, expect, it, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PracticeService, extractJsonObject, parseFeedback, parseScorecard } from '../src/main/services/practice/practice-service'
import { SQLiteStore } from '../src/main/services/context/sqlite-store'
import { AIProvider, ChatStreamRequest, ProviderError } from '../src/main/services/providers/types'
import { PracticeFeedback } from '../src/shared/protocol'

/**
 * Practice service tests run the FULL mock-interview loop against a scripted
 * fake provider — question generation, per-answer rubric evaluation, the
 * final scorecard — using the real SQLite store. No real provider involved.
 */

const dirs: string[] = []
const stores: SQLiteStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempStore(): SQLiteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-'))
  dirs.push(dir)
  const store = new SQLiteStore(path.join(dir, 'context.db'))
  stores.push(store)
  return store
}

type TurnKind = 'question' | 'eval' | 'scorecard'

const FEEDBACK_JSON = JSON.stringify({
  overall: 3,
  dimensions: [
    { dimension: 'Communication', score: 4, comment: 'Clear structure.' },
    { dimension: 'Technical accuracy', score: 3, comment: 'Mostly right.' },
    { dimension: 'Relevance', score: 3, comment: 'On topic.' },
    { dimension: 'Completeness', score: 2, comment: 'Missed the result.' },
    { dimension: 'Problem solving', score: 3, comment: 'Adequate.' }
  ],
  strengths: ['Specific example'],
  improvements: ['Add a measurable result'],
  improvedAnswer: 'A tightened version of what the candidate said.'
})

const SCORECARD_JSON = JSON.stringify({
  overall: 3,
  communication: 4,
  technicalAccuracy: 3,
  relevance: 3,
  completeness: 2,
  problemSolving: 3,
  summary: 'Solid structure, thin on outcomes.',
  areasForImprovement: ['Quantify results', 'Go deeper on trade-offs']
})

/** Provider that answers per system prompt: question → eval JSON → scorecard JSON. */
function scriptedProvider(): {
  provider: AIProvider
  requests: Array<{ messages: Array<{ role: string; content: string }>; kind: TurnKind }>
} {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; kind: TurnKind }> = []
  const provider: AIProvider = {
    id: 'fake',
    label: 'Fake',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream(req: ChatStreamRequest) {
      const system = String(req.messages[0]?.content ?? '')
      const kind: TurnKind = system.includes('interview evaluator')
        ? 'eval'
        : system.includes('FINAL SCORECARD')
          ? 'scorecard'
          : 'question'
      requests.push({ messages: req.messages as Array<{ role: string; content: string }>, kind })
      let text: string
      if (kind === 'question') text = `Question ${requests.filter((r) => r.kind === 'question').length}: Tell me about a hard decision.`
      else if (kind === 'eval') text = FEEDBACK_JSON
      else text = SCORECARD_JSON
      yield { type: 'delta', text }
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return { provider, requests }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await delay(5)
  }
}

function makeService(opts?: { provider?: AIProvider }) {
  const store = tempStore()
  const scripted = opts?.provider ? null : scriptedProvider()
  const provider = opts?.provider ?? scripted!.provider
  const events = {
    questions: [] as Array<{ practiceId: string; index: number; question: string }>,
    evaluated: [] as Array<{ practiceId: string; index: number; feedback: PracticeFeedback }>,
    finished: [] as Array<{ practiceId: string; scorecard: { overall: number } }>,
    errors: [] as Array<{ practiceId: string; message: string }>,
    deltas: [] as Array<{ kind: string; delta: string }>
  }
  const service = new PracticeService({
    store,
    resolveProvider: () => ({ provider, model: 'fake-model' }),
    getProfileFacts: (profileId) => (profileId === 'default' ? ['6 years of TypeScript'] : []),
    getResponseLanguage: () => 'auto'
  })
  service.bindEvents({
    onDelta: (e) => events.deltas.push({ kind: e.kind, delta: e.delta }),
    onQuestion: (e) => events.questions.push(e),
    onEvaluated: (e) => events.evaluated.push(e),
    onFinished: (e) => events.finished.push(e),
    onError: (e) => events.errors.push(e)
  })
  return { service, store, events, requests: scripted?.requests ?? [] }
}

const START = {
  type: 'behavioral' as const,
  difficulty: 'medium' as const,
  questionCount: 2,
  jobDescription: '',
  customFocus: '',
  role: 'Backend engineer',
  profileId: 'default'
}

describe('PracticeService — full mock interview loop', () => {
  it('generates question 1, evaluates the answer, asks question 2, then produces a scorecard', async () => {
    const { service, store, events, requests } = makeService()
    const started = service.start(START)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await waitFor(() => events.questions.length === 1)
    expect(events.questions[0].index).toBe(1)
    expect(events.questions[0].question).toContain('Tell me about a hard decision')

    // Question persisted; the session is active in the store.
    expect(store.listPracticeTurns(started.practiceId)).toHaveLength(1)
    expect(store.getPracticeSession(started.practiceId)?.status).toBe('active')

    // Answer question 1 → evaluation → question 2.
    const submitted = service.submit(started.practiceId, 'I led a migration under a deadline.', false)
    expect(submitted.ok).toBe(true)
    await waitFor(() => events.evaluated.length === 1)
    expect(events.evaluated[0].feedback.overall).toBe(3)
    expect(events.evaluated[0].feedback.improvedAnswer).toContain('tightened version')
    await waitFor(() => events.questions.length === 2)
    expect(events.questions[1].index).toBe(2)
    // The evaluation context includes the candidate's answer.
    const evalReq = requests.find((r) => r.kind === 'eval')!
    expect(JSON.stringify(evalReq.messages)).toContain('I led a migration under a deadline')

    // Answer question 2 → evaluation → automatic scorecard (2 of 2 done).
    await waitFor(() => store.listPracticeTurns(started.practiceId).length === 2)
    void service.submit(started.practiceId, 'Second answer about triaging an outage.', false)
    await waitFor(() => events.finished.length === 1)
    expect(events.finished[0].scorecard.overall).toBe(3)
    const record = store.getPracticeSession(started.practiceId)
    expect(record?.status).toBe('completed')
    expect(record?.scorecardJson).not.toBeNull()
    // Anti-fabrication is contractual in every practice system prompt.
    for (const r of requests) {
      expect(r.messages[0].content).toMatch(/never/i) // anti-fabrication present
    }
  })

  it('persists answers and feedback so a session survives restart', async () => {
    const { service, store } = makeService()
    const started = service.start(START)
    if (!started.ok) throw new Error('start failed')
    await waitFor(() => store.listPracticeTurns(started.practiceId).length === 1)
    void service.submit(started.practiceId, 'My answer.', true)
    await waitFor(() => store.listPracticeTurns(started.practiceId)[0]?.answer === 'My answer.')
    await waitFor(() => store.listPracticeTurns(started.practiceId)[0]?.feedbackJson !== null)
    const turn = store.listPracticeTurns(started.practiceId)[0]
    expect(turn.spoken).toBe(true)
    const feedback = JSON.parse(turn.feedbackJson!) as PracticeFeedback
    expect(feedback.dimensions).toHaveLength(5)
  })

  it('rejects a second concurrent session and an unknown submit', async () => {
    const { service } = makeService()
    const first = service.start(START)
    expect(first.ok).toBe(true)
    const second = service.start(START)
    expect(second.ok).toBe(false)
    expect(service.submit('pr-nope', 'x', false).ok).toBe(false)
  })

  it('marks a session cancelled and aborts in-flight generation', async () => {
    const { service, store } = makeService()
    const started = service.start(START)
    if (!started.ok) throw new Error('start failed')
    const res = service.cancel(started.practiceId)
    expect(res.ok).toBe(true)
    expect(store.getPracticeSession(started.practiceId)?.status).toBe('cancelled')
    expect(service.activePracticeId).toBeNull()
  })

  it('surfaces malformed evaluation JSON as an error instead of crashing', async () => {
    const badProvider: AIProvider = {
      id: 'bad',
      label: 'Bad',
      capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
      async *chatStream() {
        yield { type: 'delta', text: 'Question one?' }
      },
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    // First call (question) returns text; eval call returns garbage.
    let calls = 0
    const provider: AIProvider = {
      ...badProvider,
      async *chatStream(req) {
        calls += 1
        if (calls === 1) yield { type: 'delta', text: 'Q1: tell me about scale.' }
        else yield { type: 'delta', text: 'not json at all {' }
      }
    }
    const { service, events } = makeService({ provider })
    const started = service.start(START)
    if (!started.ok) throw new Error('start failed')
    await waitFor(() => events.questions.length === 1)
    void service.submit(started.practiceId, 'answer', false)
    await waitFor(() => events.errors.length === 1)
    expect(events.errors[0].message).toContain('not valid JSON')
  })

  it('start fails cleanly without a provider', () => {
    const store = tempStore()
    stores.push(store)
    const service = new PracticeService({
      store,
      resolveProvider: () => null,
      getProfileFacts: () => [],
      getResponseLanguage: () => 'auto'
    })
    const res = service.start(START)
    expect(res.ok).toBe(false)
    expect((res as { message: string }).message).toContain('No AI provider')
  })

  it('listSessions / getDetail / deleteSession round-trip', async () => {
    const { service, store } = makeService()
    const started = service.start(START)
    if (!started.ok) throw new Error('start failed')
    await waitFor(() => store.listPracticeTurns(started.practiceId).length === 1)
    void service.submit(started.practiceId, 'answer', false)
    await waitFor(() => store.listPracticeTurns(started.practiceId).length === 2)
    void service.submit(started.practiceId, 'second answer', false)
    await waitFor(() => service.listSessions()[0]?.status === 'completed')
    const list = service.listSessions()
    expect(list).toHaveLength(1)
    expect(list[0].scorecard?.overall).toBe(3)
    const detail = service.getDetail(started.practiceId)
    expect(detail?.turns).toHaveLength(2)
    expect(detail?.turns.every((t) => t.feedback)).toBe(true)
    expect(service.deleteSession(started.practiceId).ok).toBe(true)
    expect(service.getDetail(started.practiceId)).toBeUndefined()
  })
})

describe('Practice JSON parsing (fence-tolerant, honest clamping)', () => {
  it('extracts JSON wrapped in markdown fences', () => {
    const fenced = 'Here is the evaluation:\n```json\n' + FEEDBACK_JSON + '\n```\nDone.'
    const parsed = parseFeedback(fenced)
    expect(parsed).not.toBeNull()
    expect(parsed?.overall).toBe(3)
    expect(parsed?.dimensions).toHaveLength(5)
  })

  it('clamps out-of-range scores into 1..5', () => {
    const parsed = parseFeedback(
      JSON.stringify({
        overall: 9,
        dimensions: [{ dimension: 'Communication', score: 0, comment: '' }],
        strengths: [],
        improvements: [],
        improvedAnswer: ''
      })
    )
    expect(parsed?.overall).toBe(5)
    expect(parsed?.dimensions[0].score).toBe(1)
  })

  it('returns null for non-JSON or missing dimensions', () => {
    expect(parseFeedback('no json here')).toBeNull()
    expect(parseFeedback('{"overall":3}')).toBeNull()
    expect(parseScorecard('{"noSummary":true}')).toBeNull()
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject('broken')).toBeNull()
  })

  it('parses a valid scorecard', () => {
    const parsed = parseScorecard(SCORECARD_JSON)
    expect(parsed?.communication).toBe(4)
    expect(parsed?.areasForImprovement).toHaveLength(2)
  })
})

describe('PracticeService — provider failures surface as errors', () => {
  it('reports a ProviderError from the stream', async () => {
    const failing: AIProvider = {
      id: 'fail',
      label: 'Fail',
      capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
      async *chatStream() {
        throw new ProviderError('Could not reach provider')
      },
      testConnection: () => Promise.resolve({ ok: false, message: 'no', latencyMs: null })
    }
    const { service, events } = makeService({ provider: failing })
    const started = service.start(START)
    if (!started.ok) throw new Error('start failed')
    await waitFor(() => events.errors.length === 1)
    expect(events.errors[0].message).toContain('Could not reach provider')
  })
})
