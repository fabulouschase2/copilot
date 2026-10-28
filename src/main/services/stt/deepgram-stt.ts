/**
 * Deepgram streaming adapter: genuine bidirectional WebSocket STT with
 * interim (partial) results and final utterances. PCM16/16kHz frames are
 * sent as binary; results arrive as JSON. The WebSocket factory is
 * injectable so tests run without network or credentials.
 */
import { StreamingSttAdapter, StreamingSttEvents, StreamingSttHandle, mapSttHttpError } from './types'

export interface DeepgramSttConfig {
  id: string
  label: string
  baseUrl: string // e.g. https://api.deepgram.com
  apiKey: string
  model: string
  language: string
}

export interface WebSocketLike {
  send(data: string | ArrayBufferLike): void
  close(code?: number): void
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike

const OPEN = 1

export class DeepgramStt implements StreamingSttAdapter {
  readonly kind = 'stt-stream' as const
  readonly label: string
  readonly capabilities = { partial: true, final: true, transport: 'websocket' as const }

  constructor(
    private cfg: DeepgramSttConfig,
    private wsFactory: WebSocketFactory = defaultWsFactory
  ) {
    this.label = cfg.label
  }

  start(events: StreamingSttEvents): StreamingSttHandle {
    const url =
      `${this.cfg.baseUrl.replace(/^http/, 'ws')}/v1/listen` +
      `?model=${encodeURIComponent(this.cfg.model)}` +
      `&language=${encodeURIComponent(this.cfg.language)}` +
      `&encoding=linear16&sample_rate=16000&interim_results=true&punctuate=true`
    const ws = this.wsFactory(url, {
      Authorization: `Token ${this.cfg.apiKey}`
    })

    let finalizedText = ''
    let finished = false
    let errored = false

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: {
        type?: string
        channel?: { alternatives?: Array<{ transcript?: string }> }
        is_final?: boolean
        speech_final?: boolean
      }
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type !== 'Results') return
      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''
      if (msg.is_final) {
        finalizedText = `${finalizedText} ${transcript}`.trim()
      }
      if (typeof transcript === 'string' && transcript.length > 0 && !msg.is_final) {
        // interim result for the current utterance
        const interim = `${finalizedText} ${transcript}`.trim()
        events.onPartial('current', interim)
      }
      if (msg.speech_final) {
        const text = finalizedText.trim()
        if (text.length > 0) events.onFinal('current', text)
        finalizedText = ''
      }
    }

    ws.onerror = () => {
      if (finished || errored) return
      errored = true
      events.onError('STT stream error — check provider status and credentials')
    }

    ws.onclose = (ev) => {
      if (finished) return
      // 1000/1001 = intentional close; anything else before finish is an error
      if (ev.code !== 1000 && ev.code !== 1001 && !errored) {
        errored = true
        events.onError(`STT stream closed unexpectedly (code ${ev.code ?? 'unknown'})`)
      }
    }

    // Open the socket lazily from the consumer side: Node's WebSocket connects
    // on construction; audio sent before OPEN would be lost, so queue it.
    const queue: Int16Array[] = []
    let opened = false

    const flush = (): void => {
      for (const pcm of queue.splice(0)) {
        ws.send(pcm.buffer as ArrayBuffer)
      }
    }
    ws.onopen = () => {
      opened = true
      flush()
    }

    const handle: StreamingSttHandle = {
      sendAudio(pcm: Int16Array): void {
        if (finished) return
        if (opened && ws.readyState === OPEN) {
          ws.send(pcm.buffer as ArrayBuffer)
        } else {
          queue.push(pcm)
        }
      },
      finish: (): Promise<void> => {
        finished = true
        try {
          ws.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {
          /* socket already gone */
        }
        ws.close(1000)
        return Promise.resolve()
      },
      abort: (): void => {
        finished = true
        try {
          ws.close(1001)
        } catch {
          /* socket already gone */
        }
      }
    }
    return handle
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const started = Date.now()
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/projects`, {
        method: 'GET',
        headers: { Authorization: `Token ${this.cfg.apiKey}` },
        signal: AbortSignal.timeout(10_000)
      })
      const latencyMs = Date.now() - started
      if (res.ok) return { ok: true, message: 'Connected', latencyMs }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Authentication failed — check the API key', latencyMs }
      }
      return { ok: false, message: mapSttHttpError(res.status), latencyMs }
    } catch (err) {
      return {
        ok: false,
        message: `Could not reach provider: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: null
      }
    }
  }
}

function defaultWsFactory(url: string, headers: Record<string, string>): WebSocketLike {
  // Node 22+/Electron expose the WHATWG WebSocket globally. Browsers ignore
  // custom headers, so auth travels via the standard subprotocol trick used
  // by Deepgram: an extra Sec-WebSocket-Protocol entry.
  const ws = new globalThis.WebSocket(url, ['token', headers.Authorization ?? '']) as unknown as WebSocketLike
  return ws
}
