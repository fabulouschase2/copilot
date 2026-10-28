/**
 * Adapter for any OpenAI-compatible chat-completions endpoint.
 * Covers OpenAI, OpenRouter, Groq, Together, and local runtimes exposing an
 * OpenAI-style API such as Ollama (http://localhost:11434/v1) or LM Studio
 * (http://localhost:1234/v1). One adapter, many providers.
 */
import {
  AIProvider,
  ChatStreamRequest,
  ConnectionTestResult,
  ProviderCapabilities,
  ProviderError,
  StreamChunk,
  mapHttpError
} from './types'

export interface OpenAICompatibleConfig {
  id: string
  label: string
  baseUrl: string
  /** May be empty for local runtimes that do not require auth. */
  apiKey: string
  model: string
  vision: boolean
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string
  readonly label: string

  constructor(
    private cfg: OpenAICompatibleConfig,
    private fetchImpl: typeof fetch = fetch
  ) {
    this.id = cfg.id
    this.label = cfg.label
    if (!cfg.baseUrl.startsWith('http://') && !cfg.baseUrl.startsWith('https://')) {
      throw new ProviderError('baseUrl must start with http:// or https://')
    }
    // Normalize: no trailing slash (a pasted ".../v1" or ".../openai/" must
    // both join cleanly — real-world finding from the Gemini endpoint).
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') }
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, streaming: true, vision: this.cfg.vision, transcription: false }
  }

  async *chatStream(req: ChatStreamRequest): AsyncGenerator<StreamChunk> {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`

    let res: Response
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {})
        }),
        signal
      })
    } catch (err) {
      if (signal.aborted) throw new ProviderError('Request cancelled')
      throw new ProviderError(`Could not reach provider at ${this.cfg.baseUrl}: ${reasonText(err)}`)
    }

    if (!res.ok) throw mapHttpError(res.status, await safeBodyText(res))
    if (!res.body) throw new ProviderError('Provider returned an empty response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') return
          let parsed: {
            choices?: Array<{ delta?: { content?: string | null } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue // tolerate keep-alive/comment lines
          }
          const text = parsed.choices?.[0]?.delta?.content
          if (typeof text === 'string' && text.length > 0) yield { type: 'delta', text }
          if (parsed.usage) {
            yield {
              type: 'usage',
              inputTokens: parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.completion_tokens
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now()
    const headers: Record<string, string> = {}
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000)
      })
      const latencyMs = Date.now() - started
      if (res.ok) return { ok: true, message: 'Connected', latencyMs }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Authentication failed — check the API key', latencyMs }
      }
      return { ok: false, message: `Provider responded with HTTP ${res.status}`, latencyMs }
    } catch (err) {
      return { ok: false, message: `Could not reach provider: ${reasonText(err)}`, latencyMs: null }
    }
  }
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function reasonText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
