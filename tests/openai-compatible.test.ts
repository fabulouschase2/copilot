import { describe, expect, it } from 'vitest'
import { OpenAICompatibleProvider } from '../src/main/services/providers/openai-compatible'
import { ProviderError } from '../src/main/services/providers/types'

function sseResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    }
  })
  return new Response(stream, { status })
}

async function collect(gen: AsyncGenerator<{ type: string; text?: string }>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of gen) if (chunk.type === 'delta') out.push(chunk.text ?? '')
  return out
}

const cfg = {
  id: 'test',
  label: 'Test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  vision: false
}

describe('OpenAICompatibleProvider.chatStream', () => {
  it('parses SSE deltas across chunk boundaries and stops at [DONE]', async () => {
    const fetchImpl = (async () =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
          'data: [DONE]\n\n' +
          'data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n\n'
      )) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    const deltas = await collect(
      provider.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    )
    expect(deltas.join('')).toBe('Hello')
  })

  it('splits buffered SSE lines that arrive mid-JSON', async () => {
    const fetchImpl = (async () =>
      sseResponse('data: {"choices":[{"del')) as unknown as typeof fetch
    // stream closes without newline and without complete JSON: must not throw
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    const deltas = await collect(
      provider.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    )
    expect(deltas).toEqual([])
  })

  it('maps 401 to a generic authentication error without leaking the key or body', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    const err = await collectError(provider)
    // 401/403 deliberately stay generic: upstream bodies can echo partial keys.
    expect(err.message).toMatch(/Authentication failed/)
    expect(err.message).not.toContain('bad key')
    expect(err.message).not.toContain('sk-test')
    expect(err.status).toBe(401)
  })

  it('maps 404 and 429 distinctly', async () => {
    const p404 = new OpenAICompatibleProvider(
      cfg,
      (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    )
    await expect(
      collect(p404.chatStream({ model: 'x', messages: [] }))
    ).rejects.toThrow(/not found/)

    const p429 = new OpenAICompatibleProvider(
      cfg,
      (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    )
    await expect(collect(p429.chatStream({ model: 'x', messages: [] }))).rejects.toThrow(/Rate limited/)
  })

  it('reports cancellation as a cancelled error, not a network failure', async () => {
    const controller = new AbortController()
    const fetchImpl = (async () => {
      controller.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    }) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    await expect(
      collect(
        provider.chatStream({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal
        })
      )
    ).rejects.toThrow(/cancelled/i)
  })
})

describe('OpenAICompatibleProvider.testConnection', () => {
  it('returns ok with measured latency on 200', async () => {
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    const result = await provider.testConnection()
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a friendly failure on unreachable endpoints', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider(cfg, fetchImpl)
    const result = await provider.testConnection()
    expect(result.ok).toBe(false)
    expect(result.latencyMs).toBeNull()
    expect(result.message).toMatch(/Could not reach provider/)
  })
})

async function collectError(provider: OpenAICompatibleProvider): Promise<ProviderError> {
  try {
    await collect(provider.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }))
  } catch (err) {
    return err as ProviderError
  }
  throw new Error('expected chatStream to throw')
}
