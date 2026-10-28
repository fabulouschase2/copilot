import { describe, expect, it } from 'vitest'
import { DeepgramStt, WebSocketFactory, WebSocketLike } from '../src/main/services/stt/deepgram-stt'
import { SegmentStt } from '../src/main/services/stt/segment-stt'
import { StreamingSttEvents } from '../src/main/services/stt/types'

const SEG_CFG = {
  id: 'stt1',
  label: 'Groq Whisper',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'gsk-secret',
  model: 'whisper-large-v3',
  language: 'en'
}

function okJson(text: string): Response {
  return new Response(JSON.stringify({ text }), { status: 200 })
}

describe('SegmentStt (OpenAI-compatible /audio/transcriptions)', () => {
  it('sends a WAV file field plus model and language, and returns the transcript', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return okJson('hello world')
    }) as unknown as typeof fetch
    const stt = new SegmentStt(SEG_CFG, fetchImpl)
    expect(stt.capabilities).toEqual({ partial: false, final: true, transport: 'http-batch' })

    const pcm = new Int16Array(1600)
    const result = await stt.transcribe({ pcm, language: 'en' })
    expect(result.text).toBe('hello world')

    const req = captured as unknown as { url: string; init: RequestInit }
    expect(req.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer gsk-secret')
    const form = req.init.body as FormData
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('segment.wav')
    expect(file.size).toBe(44 + pcm.length * 2)
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('language')).toBe('en')
  })

  it('maps auth errors to a friendly message without leaking the key', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const stt = new SegmentStt(SEG_CFG, fetchImpl)
    await expect(stt.transcribe({ pcm: new Int16Array(16) })).rejects.toThrow(/check the API key/)
    await expect(stt.transcribe({ pcm: new Int16Array(16) })).rejects.toThrow(/401/)
  })

  it('reports network failures as unreachable, not as transcript results', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const stt = new SegmentStt(SEG_CFG, fetchImpl)
    await expect(stt.transcribe({ pcm: new Int16Array(16) })).rejects.toThrow(/Could not reach STT provider/)
  })

  it('honours cancellation', async () => {
    const controller = new AbortController()
    const fetchImpl = (async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    const stt = new SegmentStt(SEG_CFG, fetchImpl)
    await expect(
      stt.transcribe({ pcm: new Int16Array(16), signal: controller.signal })
    ).rejects.toThrow(/cancelled/i)
  })
})

/* ── Deepgram streaming adapter with a fake WebSocket ─────────────────── */

class FakeWs implements WebSocketLike {
  sent: Array<string | ArrayBuffer> = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  closedWith: number | null = null

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data as string | ArrayBuffer)
  }

  close(code = 1000): void {
    if (this.closedWith !== null) return
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({ code })
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

function makeDeepgram() {
  const ws = new FakeWs()
  const factory: WebSocketFactory = (url) => {
    urls.push(url)
    return ws
  }
  const urls: string[] = []
  const adapter = new DeepgramStt(
    {
      id: 'dg',
      label: 'Deepgram Nova',
      baseUrl: 'https://api.deepgram.com',
      apiKey: 'dg-secret',
      model: 'nova-2',
      language: 'en'
    },
    factory
  )
  const events: { partials: string[]; finals: string[]; errors: string[] } = {
    partials: [],
    finals: [],
    errors: []
  }
  const handlers: StreamingSttEvents = {
    onPartial: (_k, t) => events.partials.push(t),
    onFinal: (_k, t) => events.finals.push(t),
    onError: (m) => events.errors.push(m)
  }
  const handle = adapter.start(handlers)
  return { ws, adapter, events, handle, urls }
}

describe('DeepgramStt (streaming, fake socket)', () => {
  it('declares genuine streaming capabilities', () => {
    const { adapter } = makeDeepgram()
    expect(adapter.capabilities).toEqual({ partial: true, final: true, transport: 'websocket' })
  })

  it('builds a linear16 listen URL and queues audio until the socket opens', () => {
    const { ws, handle, urls } = makeDeepgram()
    expect(urls[0]).toContain('/v1/listen')
    expect(urls[0]).toContain('model=nova-2')
    expect(urls[0]).toContain('encoding=linear16&sample_rate=16000')
    expect(urls[0]).toContain('interim_results=true')

    const pcm = new Int16Array(320)
    handle.sendAudio(pcm)
    expect(ws.sent.filter((d) => typeof d !== 'string')).toHaveLength(0) // queued
    ws.open()
    expect(ws.sent.filter((d) => typeof d !== 'string')).toHaveLength(1)
  })

  it('emits partials for interim results and finals on speech_final', () => {
    const { ws, events, handle } = makeDeepgram()
    ws.open()
    handle.sendAudio(new Int16Array(320))

    ws.emit({ type: 'Results', channel: { alternatives: [{ transcript: 'hel' }] }, is_final: false })
    expect(events.partials).toEqual(['hel'])

    ws.emit({
      type: 'Results',
      channel: { alternatives: [{ transcript: 'hello world' }] },
      is_final: true
    })
    expect(events.finals).toHaveLength(0) // accumulated, waits for speech_final

    ws.emit({
      type: 'Results',
      channel: { alternatives: [{ transcript: '' }] },
      is_final: false,
      speech_final: true
    })
    expect(events.finals).toEqual(['hello world'])

    // next utterance starts fresh
    ws.emit({ type: 'Results', channel: { alternatives: [{ transcript: 'next' }] }, is_final: false })
    ws.emit({
      type: 'Results',
      channel: { alternatives: [{ transcript: 'next utterance' }] },
      is_final: true,
      speech_final: true
    })
    expect(events.finals).toEqual(['hello world', 'next utterance'])
  })

  it('reports unexpected closes as errors but treats clean closes as normal', () => {
    const a = makeDeepgram()
    a.ws.open()
    a.ws.close(1006)
    expect(a.events.errors).toHaveLength(1)
    expect(a.events.errors[0]).toMatch(/1006/)

    const b = makeDeepgram()
    b.ws.open()
    void b.handle.finish()
    expect(b.events.errors).toHaveLength(0)
    expect(b.ws.sent.some((d) => typeof d === 'string' && d.includes('CloseStream'))).toBe(true)
    expect(b.ws.closedWith).toBe(1000)
  })

  it('ignores audio sent after finish()', () => {
    const { ws, handle } = makeDeepgram()
    ws.open()
    void handle.finish()
    const count = ws.sent.length
    handle.sendAudio(new Int16Array(320))
    expect(ws.sent.length).toBe(count)
  })
})
