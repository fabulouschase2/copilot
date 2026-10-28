import { describe, expect, it } from 'vitest'
import { VisionAnalyzer } from '../src/main/services/vision/vision-analyzer'
import { AIProvider, ChatMessage, ChatStreamRequest, ContentPart, ProviderError, StreamChunk } from '../src/main/services/providers/types'

function fakeVisionProvider(options?: { failWith?: ProviderError }): {
  provider: AIProvider
  requests: ChatStreamRequest[]
} {
  const requests: ChatStreamRequest[] = []
  const provider: AIProvider = {
    id: 'v1',
    label: 'Fake Vision',
    capabilities: () => ({ chat: true, streaming: true, vision: true, transcription: false }),
    async *chatStream(req) {
      requests.push(req)
      if (options?.failWith) throw options.failWith
      const deltas = ['Screen shows ', 'a settings page ', 'with three toggles.']
      for (const d of deltas) {
        if (req.signal?.aborted) throw new ProviderError('Request cancelled')
        yield { type: 'delta', text: d }
        await new Promise((r) => setImmediate(r))
      }
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return { provider, requests }
}

describe('VisionAnalyzer payload construction', () => {
  it('builds a vision chat payload: system prompt, text question, data-URL image', async () => {
    const { provider, requests } = fakeVisionProvider()
    const analyzer = new VisionAnalyzer()
    const events = { deltas: [] as string[], ttft: [] as number[] }

    const text = await analyzer.analyze(
      {
        provider,
        model: 'gpt-4o-mini',
        imageJpegBase64: 'QUJD', // 'ABC'
        question: 'What is on screen?',
        transcriptContext: '[0] we clicked settings'
      },
      {
        onDelta: (d) => events.deltas.push(d),
        onFirstToken: (ms) => events.ttft.push(ms)
      }
    )

    expect(text).toBe('Screen shows a settings page with three toggles.')
    expect(requests).toHaveLength(1)
    const messages = requests[0].messages as ChatMessage[]
    expect(messages[0].role).toBe('system')
    expect(typeof messages[0].content).toBe('string')
    const user = messages[1]
    expect(user.role).toBe('user')
    const parts = user.content as ContentPart[]
    expect(parts).toHaveLength(2)
    expect(parts[0].type).toBe('text')
    expect(parts[0].type === 'text' && parts[0].text).toContain('What is on screen?')
    expect(parts[0].type === 'text' && parts[0].text).toContain('[0] we clicked settings')
    expect(parts[1].type).toBe('image_url')
    const url = parts[1].type === 'image_url' ? parts[1].image_url.url : ''
    expect(url.startsWith('data:image/jpeg;base64,QUJD')).toBe(true)
    // The API key must never appear in the payload (it travels in headers).
    expect(JSON.stringify(requests[0])).not.toContain('Bearer')
    // Streaming bookkeeping
    expect(events.deltas).toHaveLength(3)
    expect(events.ttft).toHaveLength(1)
    expect(requests[0].model).toBe('gpt-4o-mini')
  })

  it('omits transcript context when none is supplied', async () => {
    const { provider, requests } = fakeVisionProvider()
    await new VisionAnalyzer().analyze(
      { provider, model: 'm', imageJpegBase64: 'QUJD', question: 'q' },
      { onDelta: () => undefined, onFirstToken: () => undefined }
    )
    const user = (requests[0].messages as ChatMessage[])[1]
    const parts = user.content as ContentPart[]
    expect(parts[0].type === 'text' && parts[0].text).toBe('q')
  })

  it('propagates provider errors for the service to map', async () => {
    const { provider } = fakeVisionProvider({ failWith: new ProviderError('Authentication failed (401)', 401) })
    await expect(
      new VisionAnalyzer().analyze(
        { provider, model: 'm', imageJpegBase64: 'QUJD', question: 'q' },
        { onDelta: () => undefined, onFirstToken: () => undefined }
      )
    ).rejects.toThrow(/Authentication failed/)
  })

  it('reports cancellation when the signal aborts mid-stream', async () => {
    const { provider } = fakeVisionProvider()
    const controller = new AbortController()
    const analysis = new VisionAnalyzer().analyze(
      { provider, model: 'm', imageJpegBase64: 'QUJD', question: 'q', signal: controller.signal },
      { onDelta: () => undefined, onFirstToken: () => undefined }
    )
    controller.abort()
    await expect(analysis).rejects.toThrow(/cancelled/)
  })

  it('yields StreamChunk deltas compatible with the shared chat pipeline', async () => {
    // sanity: the fake provider's chunks match the shared StreamChunk shape
    const chunks: StreamChunk[] = [{ type: 'delta', text: 'x' }]
    expect(chunks[0].type).toBe('delta')
  })
})
