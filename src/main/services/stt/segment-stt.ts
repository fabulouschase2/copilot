/**
 * Segment STT adapter for OpenAI-compatible /audio/transcriptions endpoints
 * (OpenAI whisper-1, Groq whisper-large-v3, local whisper.cpp server).
 * Batch transport: one VAD utterance per request. No partials — by design,
 * not by omission; the capability flag says so.
 */
import { encodeWav } from '../audio/pcm'
import { SegmentSttAdapter, SttResult, SttTranscribeRequest, mapSttHttpError } from './types'

export interface SegmentSttConfig {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  model: string
  language?: string
}

export class SegmentStt implements SegmentSttAdapter {
  readonly kind = 'stt-segment' as const
  readonly label: string
  readonly capabilities = { partial: false, final: true, transport: 'http-batch' as const }

  constructor(
    private cfg: SegmentSttConfig,
    private fetchImpl: typeof fetch = fetch
  ) {
    this.label = cfg.label
    if (!cfg.baseUrl.startsWith('http://') && !cfg.baseUrl.startsWith('https://')) {
      throw new Error('STT baseUrl must start with http:// or https://')
    }
  }

  async transcribe(req: SttTranscribeRequest): Promise<SttResult> {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? 30_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const wav = encodeWav(req.pcm, 16_000)
    const form = new FormData()
    form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'segment.wav')
    form.append('model', this.cfg.model)
    const language = req.language ?? this.cfg.language
    if (language && language !== 'auto') form.append('language', language)

    let res: Response
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        body: form,
        signal
      })
    } catch (err) {
      if (signal.aborted) throw new Error('Transcription cancelled')
      throw new Error(`Could not reach STT provider: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(mapSttHttpError(res.status))
    const parsed = (await res.json()) as { text?: unknown }
    if (typeof parsed?.text !== 'string') throw new Error('STT provider returned an unexpected response')
    return { text: parsed.text.trim() }
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
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
      return {
        ok: false,
        message: `Could not reach provider: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: null
      }
    }
  }
}
