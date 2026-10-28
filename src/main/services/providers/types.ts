/**
 * Common interface every AI provider adapter must implement (Module D).
 * The application only ever talks to providers through this interface so
 * adapters can be added or replaced without touching call sites.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** Plain text for chat; content parts for vision requests (Stage 6). */
  content: string | ContentPart[]
}

export interface ProviderCapabilities {
  chat: boolean
  streaming: boolean
  vision: boolean
  transcription: boolean
}

export interface ChatStreamRequest {
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  /** Overall request deadline in ms. */
  timeoutMs?: number
  maxTokens?: number
}

export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }

export interface ConnectionTestResult {
  ok: boolean
  /** Human-readable, secret-free result message. */
  message: string
  latencyMs: number | null
}

export interface AIProvider {
  readonly id: string
  readonly label: string
  capabilities(): ProviderCapabilities
  /** Streaming chat completion. Yields deltas; throws ProviderError on failure. */
  chatStream(req: ChatStreamRequest): AsyncGenerator<StreamChunk>
  testConnection(): Promise<ConnectionTestResult>
}

/** Error with a user-presentable message; never embeds credentials. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function mapHttpError(status: number, bodyText: string): ProviderError {
  let detail = ''
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
    const m = parsed?.error?.message
    if (typeof m === 'string') detail = `: ${m.slice(0, 200)}`
  } catch {
    /* body was not JSON; keep detail empty */
  }
  switch (status) {
    case 400:
      return new ProviderError(`Provider rejected the request (400)${detail}`, status)
    case 401:
    case 403:
      return new ProviderError(`Authentication failed — check the API key (${status})`, status)
    case 404:
      return new ProviderError(`Endpoint or model not found — check base URL and model name (404)`, status)
    case 429:
      return new ProviderError(`Rate limited by provider (429)${detail}`, status)
    default:
      if (status >= 500) return new ProviderError(`Provider server error (${status})`, status)
      return new ProviderError(`Provider error (HTTP ${status})${detail}`, status)
  }
}
