/**
 * Speech-to-text adapter contract (Module A).
 *
 * IMPORTANT — streaming capabilities differ per provider and must be
 * declared honestly by each adapter (spec: "Do not assume all speech-to-text
 * providers support genuine bidirectional streaming"):
 *
 *  - stt-segment (OpenAI-compatible /audio/transcriptions, e.g. OpenAI
 *    whisper-1, Groq whisper-large-v3, local whisper.cpp server):
 *    NO streaming. The pipeline records one VAD-delimited utterance and
 *    transcribes it when speech pauses. final-only; partial=false.
 *  - stt-stream (Deepgram WebSocket): genuine bidirectional streaming with
 *    interim results; partial=true, final=true.
 *
 * The service never fakes partials: when partial=false the UI simply shows
 * finals as they land.
 */
export interface SttCapabilities {
  /** Interim results during speech. */
  partial: boolean
  /** Final utterance transcripts. */
  final: boolean
  transport: 'http-batch' | 'websocket'
}

export interface SttTranscribeRequest {
  /** PCM16 mono, 16 kHz. */
  pcm: Int16Array
  language?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SttResult {
  text: string
}

export interface StreamingSttHandle {
  sendAudio(pcm: Int16Array): void
  finish(): Promise<void>
  abort(): void
}

export interface StreamingSttEvents {
  onPartial(segmentKey: string, text: string): void
  onFinal(segmentKey: string, text: string): void
  onError(message: string): void
}

export interface SegmentSttAdapter {
  readonly kind: 'stt-segment'
  readonly label: string
  readonly capabilities: SttCapabilities
  transcribe(req: SttTranscribeRequest): Promise<SttResult>
  testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number | null }>
}

export interface StreamingSttAdapter {
  readonly kind: 'stt-stream'
  readonly label: string
  readonly capabilities: SttCapabilities
  start(events: StreamingSttEvents): StreamingSttHandle
  testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number | null }>
}

export type SttAdapter = SegmentSttAdapter | StreamingSttAdapter

export function sttProviderKind(adapter: SttAdapter): 'cloud' | 'local' {
  return adapter.label.startsWith('Local') ? 'local' : 'cloud'
}

/** Human-readable, secret-free HTTP error mapping shared by both adapters. */
export function mapSttHttpError(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return `STT authentication failed — check the API key (${status})`
    case 404:
      return 'STT endpoint or model not found — check base URL and model (404)'
    case 429:
      return 'Rate limited by the STT provider (429)'
    default:
      if (status >= 500) return `STT provider server error (${status})`
      return `STT provider error (HTTP ${status})`
  }
}
