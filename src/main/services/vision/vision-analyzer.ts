/**
 * Vision analyzer (Module B/D bridge).
 *
 * Builds a vision-capable chat-completions request (text prompt + data-URL
 * image) and streams the response through the SAME AIProvider interface used
 * by chat, so provider management, cancellation, and error mapping stay
 * shared. Time-to-first-token is reported for supported providers.
 */
import { AIProvider, ChatMessage } from '../providers/types'

export interface VisionAnalysisRequest {
  provider: AIProvider
  model: string
  /** JPEG bytes, base64, no data: prefix. */
  imageJpegBase64: string
  question: string
  /** Recent transcript text from the CURRENT session, if the user opted in. */
  transcriptContext?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxTokens?: number
}

export interface VisionStreamEvents {
  onDelta(text: string): void
  onFirstToken(ttftMs: number): void
}

const SYSTEM_PROMPT =
  'You are a precise screen-analysis copilot. Describe only what is visible and relevant. ' +
  'Extract on-screen text verbatim when the question needs it. Never speculate about content ' +
  'that is not visible. Be concise unless asked for detail.'

export const VISION_TIMEOUT_MS = 90_000

export class VisionAnalyzer {
  /**
   * Stream an analysis. Resolves with the full observations text; deltas and
   * TTFT are reported through events. Throws ProviderError on failure.
   */
  async analyze(req: VisionAnalysisRequest, events: VisionStreamEvents): Promise<string> {
    const started = this.now()
    const timeout = AbortSignal.timeout(req.timeoutMs ?? VISION_TIMEOUT_MS)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout

    const userText = req.transcriptContext
      ? `${req.question}\n\nRecent conversation context (current session only):\n${req.transcriptContext}`
      : req.question

    const dataUrl = `data:image/jpeg;base64,${req.imageJpegBase64}`
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]

    let ttftSent = false
    let full = ''
    for await (const chunk of req.provider.chatStream({
      model: req.model,
      messages,
      signal,
      timeoutMs: req.timeoutMs ?? VISION_TIMEOUT_MS,
      maxTokens: req.maxTokens ?? 900
    })) {
      if (chunk.type === 'delta') {
        if (!ttftSent) {
          ttftSent = true
          events.onFirstToken(this.now() - started)
        }
        full += chunk.text
        events.onDelta(chunk.text)
      }
    }
    return full
  }

  private now(): number {
    return performance.now()
  }
}
