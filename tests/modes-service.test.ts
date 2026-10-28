import { describe, expect, it } from 'vitest'
import { assessEvidence, ModesService } from '../src/main/services/modes/modes-service'
import { RetrievalResult } from '../src/main/services/context/context-service'
import { AIProvider, ChatStreamRequest, ProviderError } from '../src/main/services/providers/types'

function fakeProvider(options?: { failWith?: ProviderError }): { provider: AIProvider; requests: ChatStreamRequest[] } {
  const requests: ChatStreamRequest[] = []
  const provider: AIProvider = {
    id: 'p1',
    label: 'Fake',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream(req) {
      requests.push(req)
      if (options?.failWith) throw options.failWith
      if (req.signal?.aborted) throw new ProviderError('Request cancelled')
      yield { type: 'delta', text: 'Situation: ' }
      if (req.signal?.aborted) throw new ProviderError('Request cancelled')
      yield { type: 'delta', text: 'the billing migration.' }
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return { provider, requests }
}

function retrieval(items: Array<{ displayName: string; score: number; type?: string }>): RetrievalResult {
  return {
    items: items.map((i, idx) => ({
      itemId: `i${idx}`,
      sourceId: `s${idx}`,
      type: (i.type ?? 'profile') as 'profile',
      displayName: i.displayName,
      text: `${i.displayName} content`,
      updatedAt: 1,
      rawScore: i.score,
      score: i.score,
      reason: 'test',
      matchedTerms: []
    })),
    estimatedTokens: 10,
    block: 'context block'
  }
}

interface Harness {
  service: ModesService
  requests: ChatStreamRequest[]
  providerRequests: number
  events: {
    deltas: Array<{ channel: string; requestId: string; delta: string }>
    results: Array<{ channel: string; requestId: string; status: string; evidenceLevel?: string; text: string; contextUsed: unknown[] }>
    errors: Array<{ channel: string; message: string }>
    questions: ModeQuestionFeed[]
  }
  sessionId: string | null
  released: Array<() => void>
}

type ModeQuestionFeed = { id: string; text: string; sessionId: string }

function makeHarness(opts?: {
  provider?: { failWith?: ProviderError }
  retrieval?: (question: string, options: unknown) => RetrievalResult
}): Harness {
  const fake = opts?.provider ? undefined : fakeProvider(opts?.provider)
  const provider = fake?.provider ?? {
    id: 'p1',
    label: 'Fake',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    // eslint-disable-next-line require-yield
    async *chatStream(req) {
      requests.push(req)
      if (opts?.provider?.failWith) throw opts.provider.failWith
      throw new Error('unused')
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  const requests: ChatStreamRequest[] = []
  void provider
  // rebind: use fake when provided
  const actual = fake ?? {
    provider: provider!,
    requests
  }
  void actual

  const h: Harness = {
    service: null as unknown as ModesService,
    requests: fake?.requests ?? requests,
    providerRequests: 0,
    events: { deltas: [], results: [], errors: [], questions: [] },
    sessionId: null,
    released: []
  }
  const retrievalFn =
    opts?.retrieval ??
    ((question: string) =>
      retrieval([{ displayName: 'resume.md', score: 0.8, type: 'document' }]))
  const service = new ModesService({
    resolveProvider: () => ({ provider: (fake?.provider ?? provider) as AIProvider, model: 'test-model' }),
    retrieve: retrievalFn,
    getSessionId: () => h.sessionId,
    saveText: async (defaultName, content) => ({ ok: true, message: `${defaultName}:${content.length}` })
  })
  service.bindEvents({
    onDelta: (channel, requestId, delta) => h.events.deltas.push({ channel, requestId, delta }),
    onResult: (e) => h.events.results.push(e),
    onError: (channel, _id, message) => h.events.errors.push({ channel, message }),
    onQuestion: (q) => h.events.questions.push(q)
  })
  h.service = service
  return h
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const v = probe()
      if (v !== undefined) return resolve(v)
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('ModesService — interview', () => {
  it('generates an answer with sources, evidence level, and STAR prompt', async () => {
    const h = makeHarness()
    h.sessionId = 'sess-1'
    const res = h.service.interviewAnswer({ question: 'Tell me about the billing migration.', style: 'star', includeSession: true })
    expect(res.ok).toBe(true)
    await waitUntil(() => h.events.results[0])

    expect(h.events.results[0].status).toBe('completed')
    expect(h.events.results[0].evidenceLevel).toBe('good')
    expect(h.events.deltas.length).toBeGreaterThanOrEqual(2)
    const system = (h.requests[0].messages as Array<{ role: string; content: string }>)[0]
    expect(system.content).toContain('STAR')
    expect(system.content).toContain('never invent')
  })

  it('flags missing evidence instead of letting the model improvise', async () => {
    const h = makeHarness({
      retrieval: () => retrieval([])
    })
    h.service.interviewAnswer({ question: 'Tell me about leading a team of fifty.', style: 'star', includeSession: false })
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].evidenceLevel).toBe('none')
  })

  it('single-slot rule and missing provider are explicit errors', () => {
    const h = makeHarness()
    // No session + a hanging provider keeps the slot busy → second is rejected.
    h.service.interviewAnswer({ question: 'q?', style: 'concise', includeSession: false })
    const second = h.service.interviewAnswer({ question: 'q2?', style: 'concise', includeSession: false })
    expect(second.ok).toBe(false)
    h.service.cancel('interview')
  })

  it('refuses to run without a configured provider', () => {
    const service = new ModesService({
      resolveProvider: () => null,
      retrieve: () => retrieval([]),
      getSessionId: () => null,
      saveText: async () => ({ ok: true })
    })
    const res = service.interviewAnswer({ question: 'q', style: 'concise', includeSession: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/No AI provider/)
  })
})

describe('ModesService — meeting', () => {
  it('requires an active session unless saved sources are explicitly included', () => {
    const h = makeHarness()
    h.sessionId = null
    const res = h.service.meetingGenerate({ kind: 'summary', includeDocuments: false, includeProfile: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/No active meeting session/)
    const optIn = h.service.meetingGenerate({ kind: 'summary', includeDocuments: true, includeProfile: false })
    expect(optIn.ok).toBe(true)
    h.service.cancel('meeting')
  })

  it('meeting Q&A is strictly current-session (no docs/profile in the prompt)', async () => {
    let capturedOptions: unknown = null
    const h = makeHarness({
      retrieval: (question, options) => {
        capturedOptions = options
        return retrieval([{ displayName: 'Live transcript', score: 0.9, type: 'transcript' }])
      }
    })
    h.sessionId = 'sess-9'
    h.service.meetingAsk({ question: 'What did we decide about the deadline?' })
    await waitUntil(() => h.events.results[0])
    expect(capturedOptions).toEqual({ includeSession: true, includeDocuments: false, includeProfile: false })
    const system = (h.requests[0].messages as Array<{ role: string; content: string }>)[0]
    expect(system.content).toMatch(/ONLY the provided transcript/i)
  })

  it('reports "nothing to summarize" when the session has no captured conversation', () => {
    const h = makeHarness({
      retrieval: () => retrieval([])
    })
    h.sessionId = 'sess-1'
    const res = h.service.meetingGenerate({ kind: 'summary', includeDocuments: false, includeProfile: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/Nothing to summarize/)
  })
})

describe('ModesService — session boundaries and question feed', () => {
  it('only accepts transcript segments from the current session; new sessions reset the feed', () => {
    const h = makeHarness()
    h.sessionId = 'sess-1'
    const found = h.service.observeTranscriptSegment(
      'sess-1',
      'How did you handle the migration? I led the effort.'
    )
    expect(found).toHaveLength(1)
    expect(h.service.questionFeed).toHaveLength(1)

    // foreign session: ignored
    expect(h.service.observeTranscriptSegment('sess-OLD', 'Why does this matter?')).toHaveLength(0)
    expect(h.service.questionFeed).toHaveLength(1)

    // new session resets
    h.service.beginSession('sess-2')
    expect(h.service.questionFeed).toHaveLength(0)
  })

  it('duplicate questions are not re-added', () => {
    const h = makeHarness()
    h.sessionId = 's'
    h.service.observeTranscriptSegment('s', 'Why does caching matter?')
    h.service.observeTranscriptSegment('s', 'why  does  caching matter?')
    expect(h.service.questionFeed).toHaveLength(1)
  })
})

describe('ModesService — cancellation and provider errors', () => {
  it('cancel produces a cancelled result, not an error', async () => {
    const h = makeHarness()
    h.service.interviewAnswer({ question: 'q?', style: 'concise', includeSession: false })
    h.service.cancel('interview')
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('cancelled')
    expect(h.events.errors).toHaveLength(0)
  })

  it('provider errors surface as errors and an error result', async () => {
    const h = makeHarness({ provider: { failWith: new ProviderError('Authentication failed — check the API key (401)', 401) } })
    h.service.interviewAnswer({ question: 'q?', style: 'concise', includeSession: false })
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('error')
    expect(h.events.errors[0].message).toMatch(/401/)
  })
})

describe('assessEvidence', () => {
  const base = { estimatedTokens: 1, block: '' }
  it('none / partial / good', () => {
    expect(assessEvidence({ items: [], ...base })).toBe('none')
    expect(assessEvidence({ items: [mkItem(0.2)], ...base })).toBe('partial')
    expect(assessEvidence({ items: [mkItem(0.5)], ...base })).toBe('good')
  })
  function mkItem(score: number) {
    return {
      itemId: 'i',
      sourceId: 's',
      type: 'profile' as const,
      displayName: 'd',
      text: 't',
      updatedAt: 0,
      rawScore: score,
      score,
      reason: 'r',
      matchedTerms: []
    }
  }
})
