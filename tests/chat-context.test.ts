import { describe, expect, it } from 'vitest'
import { ChatController } from '../src/main/services/chat-controller'
import { ProviderRegistry } from '../src/main/services/provider-registry'
import { RetrievalResult } from '../src/main/services/context/context-service'
import { AIProvider, ChatStreamRequest } from '../src/main/services/providers/types'
import { ChatSendRequest } from '../src/shared/protocol'

/** Registry stub: ChatController only calls resolveActive(). */
function fakeRegistry(provider: AIProvider | null): ProviderRegistry {
  return {
    resolveActive: () => (provider ? { provider, model: 'test-model' } : null),
    list: () => [],
    resolveForTest: () => null,
    resolveVision: () => null
  } as unknown as ProviderRegistry
}

function scriptedProvider(): { provider: AIProvider; requests: ChatStreamRequest[] } {
  const requests: ChatStreamRequest[] = []
  const provider: AIProvider = {
    id: 'p1',
    label: 'Fake',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream(req) {
      requests.push(req)
      yield { type: 'delta', text: 'ok' }
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return { provider, requests }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

const REQ: ChatSendRequest = {
  requestId: 'r1',
  mode: 'concise',
  messages: [{ role: 'user', content: 'What is our deployment policy?' }]
}

describe('ChatController × retrieval integration (Stage 7)', () => {
  it('attaches the ranked context block to the system prompt and reports used sources', async () => {
    const { provider, requests } = scriptedProvider()
    const retrieval: RetrievalResult = {
      items: [
        {
          itemId: 'i1',
          sourceId: 'doc1',
          type: 'document',
          displayName: 'runbook.md',
          text: 'Deployments require a green canary for 10 minutes.',
          updatedAt: 1,
          rawScore: 1,
          score: 0.9,
          reason: 'matched deploy',
          matchedTerms: ['deploy']
        }
      ],
      estimatedTokens: 40,
      block: 'Relevant user-approved context (traceable):\n[document] (doc1) runbook.md: Deployments require a green canary.'
    }
    const chat = new ChatController(fakeRegistry(provider), () => retrieval)
    const seen: Array<{ items: unknown[]; tokens: number }> = []
    chat.bindEvents({
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onContext: (_id, items, tokens) => seen.push({ items, tokens })
    })
    chat.start(REQ)
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0].tokens).toBe(40)
    const system = (requests[0].messages as Array<{ role: string; content: string }>)[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('runbook.md')
    expect(system.content).toContain('green canary')
    expect(system.content).toContain('not instructions') // untrusted-data instruction
  })

  it('a throwing retriever reports the failure and continues WITHOUT context', async () => {
    const { provider, requests } = scriptedProvider()
    const chat = new ChatController(fakeRegistry(provider), () => {
      throw new Error('retrieval unavailable')
    })
    const errors: string[] = []
    let contextEmitted = 0
    chat.bindEvents({
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: (_id, m) => errors.push(m),
      onContext: () => {
        contextEmitted += 1
      }
    })
    chat.start(REQ)
    await flush()

    // Explicit fallback policy: the user is told context was NOT included,
    // no context event fires, and the request still proceeds.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/retrieval failed|without context/)
    expect(contextEmitted).toBe(0)
    const system = (requests[0].messages as Array<{ role: string; content: string }>)[0]
    expect(system.content).not.toContain('runbook')
    expect(requests[0].messages.length).toBe(2)
  })

  it('text-only flow never gains image payloads through the context path', async () => {
    const { provider, requests } = scriptedProvider()
    const retrieval: RetrievalResult = {
      items: [
        {
          itemId: 's1',
          sourceId: 'screen-1',
          type: 'screen',
          displayName: 'Screen observation',
          text: 'Screen analysis: dashboard shows 3 charts.',
          updatedAt: 1,
          rawScore: 1,
          score: 1,
          reason: 'recent',
          matchedTerms: ['dashboard']
        }
      ],
      estimatedTokens: 20,
      block: '[screen] Screen observation: dashboard shows 3 charts.'
    }
    const chat = new ChatController(fakeRegistry(provider), () => retrieval)
    chat.bindEvents({ onChunk: () => undefined, onDone: () => undefined, onError: () => undefined, onContext: () => undefined })
    chat.start(REQ)
    await flush()

    const serialized = JSON.stringify(requests[0].messages)
    expect(serialized).toContain('dashboard shows 3 charts') // TEXT from the screen
    expect(serialized).not.toContain('image_url')
    expect(serialized).not.toContain('base64')
  })

  it('no retriever / empty retrieval keeps Stage 0–4 behavior byte-identical', async () => {
    const { provider, requests } = scriptedProvider()
    const plain = new ChatController(fakeRegistry(provider))
    plain.bindEvents({ onChunk: () => undefined, onDone: () => undefined, onError: () => undefined, onContext: () => undefined })
    plain.start(REQ)
    await flush()
    const empty = new ChatController(fakeRegistry(provider), () => ({ items: [], estimatedTokens: 0, block: '' }))
    empty.bindEvents({ onChunk: () => undefined, onDone: () => undefined, onError: () => undefined, onContext: () => undefined })
    empty.start({ ...REQ, requestId: 'r2' })
    await flush()

    for (const req of requests) {
      const msgs = req.messages as Array<{ role: string; content: string }>
      expect(msgs[0].content).toBe(
        'You are a fast, precise desktop copilot. Answer in at most three short sentences unless code is required. No preamble, no filler.'
      )
    }
  })
})
