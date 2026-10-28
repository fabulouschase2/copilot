import { describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { PermissionGate } from '../src/main/services/audio/permission-gate'
import { ScreenService, ScreenDeps } from '../src/main/services/screen/screen-service'
import { RawImage } from '../src/main/services/screen/image-hash'
import { AIProvider, ChatStreamRequest, ProviderError } from '../src/main/services/providers/types'
import { ScreenCaptureRequest } from '../src/shared/protocol'

function patternImage(): RawImage {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (x * 7 + y * 13) % 256
      const i = (y * W + x) * 4
      rgba[i] = v
      rgba[i + 1] = 255 - v
      rgba[i + 2] = v
      rgba[i + 3] = 255
    }
  }
  return { rgba, width: W, height: H }
}

const W = 320
const H = 200

function solidImage(r = 200, g = 100, b = 50): RawImage {
  const rgba = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return { rgba, width: W, height: H }
}

function fakeBackend(images: RawImage[]) {
  const encodeCalls: Array<{ w: number; h: number }> = []
  let captureCount = 0
  return {
    captureCount: () => captureCount,
    encodeCalls,
    listSources: async () => [{ id: 's1', name: 'Primary', thumbnailDataUrl: 'data:image/jpeg;base64,x' }],
    capture: async () => {
      const image = images[Math.min(captureCount, images.length - 1)]
      captureCount += 1
      return {
        image,
        jpegBase64: Buffer.alloc(1200).toString('base64'),
        previewDataUrl: 'data:image/jpeg;base64,preview',
        width: image.width,
        height: image.height
      }
    },
    encode: (img: RawImage) => {
      encodeCalls.push({ w: img.width, h: img.height })
      return Buffer.alloc(600).toString('base64')
    }
  }
}

/** Vision provider yielding controlled deltas with an order-independent gate. */
function fakeVision() {
  const messages: ChatStreamRequest[] = []
  let releaseRequested = false
  let gate: (() => void) | null = null
  const provider: AIProvider = {
    id: 'v1',
    label: 'Fake Vision',
    capabilities: () => ({ chat: true, streaming: true, vision: true, transcription: false }),
    async *chatStream(req) {
      messages.push(req)
      if (req.signal?.aborted) throw new ProviderError('Request cancelled')
      yield { type: 'delta', text: 'The screen shows ' }
      if (!releaseRequested) {
        await new Promise<void>((r) => {
          gate = r
        })
      }
      if (req.signal?.aborted) throw new ProviderError('Request cancelled')
      yield { type: 'delta', text: 'three toggles.' }
    },
    testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
  }
  return {
    provider,
    messages,
    release: () => {
      releaseRequested = true
      gate?.()
      gate = null
    }
  }
}

interface Harness {
  service: ScreenService
  backend: ReturnType<typeof fakeBackend>
  vision: ReturnType<typeof fakeVision>
  context: ContextEngine
  events: {
    previews: Array<{ requestId: string; dataUrl: string; width: number; height: number; similarityToPrevious: number | null; duplicate: boolean }>
    deltas: Array<{ requestId: string; delta: string }>
    results: Array<{ requestId: string; status: string; observations: string; message?: string; transcriptRefs: unknown[] }>
    errors: Array<{ requestId: string; code: string; message: string }>
    statuses: Array<{ requestId: string; phase: string }>
    metrics: Array<{ requestId: string; captureMs: number | null; duplicateDetectionMs: number }>
  }
  transcript: Array<{ segmentId: string; seq: number; text: string }>
}

function makeHarness(images?: RawImage[]): Harness {
  const backend = fakeBackend(images ?? [solidImage()])
  const vision = fakeVision()
  const context = new ContextEngine()
  const h: Harness = {
    service: null as unknown as ScreenService,
    backend,
    vision,
    context,
    events: { previews: [], deltas: [], results: [], errors: [], statuses: [], metrics: [] },
    transcript: []
  }
  const deps: ScreenDeps = {
    backend,
    resolveVision: () => ({ provider: vision.provider, model: 'gpt-4o-mini', id: 'v1', label: 'Fake Vision' }),
    getRecentTranscript: () => h.transcript,
    context,
    armGate: new PermissionGate(5 * 60_000)
  }
  const service = new ScreenService(deps)
  service.bindEvents({
    onPreview: (e) => h.events.previews.push(e),
    onDelta: (e) => h.events.deltas.push(e),
    onResult: (e) => h.events.results.push(e),
    onError: (e) => h.events.errors.push(e),
    onStatus: (e) => h.events.statuses.push(e),
    onMetrics: (e) => h.events.metrics.push(e)
  })
  h.service = service
  return h
}

function waitUntil<T>(probe: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      const v = probe()
      if (v !== undefined) return resolve(v)
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for condition'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function analyze(service: ScreenService, req?: Partial<ScreenCaptureRequest>): string {
  const res = service.analyze({
    kind: 'screen',
    question: 'What is on screen?',
    includeTranscript: false,
    includeContext: true,
    ...req
  } as ScreenCaptureRequest)
  expect(res.ok).toBe(true)
  return (res as { ok: true; requestId: string }).requestId
}

describe('ScreenService', () => {
  it('refuses everything while consent is not armed', async () => {
    const h = makeHarness()
    const res = h.service.analyze({ kind: 'screen', question: 'q', includeTranscript: false, includeContext: true })
    expect(res.ok).toBe(false)
    const sources = await h.service.listSources('screen')
    expect(sources.ok).toBe(false)
    expect(sources.message).toMatch(/not enabled/)
  })

  it('respects the single-in-flight rule', async () => {
    const h = makeHarness()
    h.service.arm(true)
    analyze(h.service)
    const second = h.service.analyze({ kind: 'screen', question: 'q', includeTranscript: false, includeContext: true })
    expect(second.ok).toBe(false)
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('completed')
  })

  it('runs the full happy path: capture → dedup → stream → result → context (text only)', async () => {
    const h = makeHarness()
    h.service.arm(true)
    const id = analyze(h.service)

    await waitUntil(() => h.events.previews[0])
    expect(h.events.previews[0].duplicate).toBe(false)
    expect(h.events.previews[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/)

    await waitUntil(() => h.events.deltas.length > 0)
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    const result = h.events.results[0]
    expect(result.status).toBe('completed')
    expect(result.observations).toBe('The screen shows three toggles.')
    expect(result.requestId).toBe(id)
    // provider received a vision payload with the backend JPEG
    const msg = h.vision.messages[0].messages as Array<{ content: unknown }>
    expect(JSON.stringify(msg)).toContain('image_url')
    // ContextEngine receives TEXT observations, never an image
    const items = h.context.snapshot()
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('screen')
    expect(items[0].text).toContain('three toggles')
    expect(JSON.stringify(items[0])).not.toContain('base64')
    // metrics: capture + dedup measured
    expect(h.events.metrics[0].captureMs).toBeGreaterThanOrEqual(0)
    expect(h.events.statuses.map((s) => s.phase)).toEqual(['capturing', 'preprocessing', 'analyzing'])
  })

  it('flags a near-identical second capture as duplicate and skips the provider', async () => {
    const h = makeHarness()
    h.service.arm(true)
    const id1 = analyze(h.service)
    h.vision.release()
    await waitUntil(() => h.events.results[0])

    const id2 = analyze(h.service)
    h.vision.release()
    await waitUntil(() => h.events.results[1])

    expect(h.events.results[1].status).toBe('duplicate')
    expect(h.events.previews[1].duplicate).toBe(true)
    expect(h.vision.messages).toHaveLength(1) // only the first capture hit the provider
    expect(h.context.snapshot()).toHaveLength(1) // duplicate added nothing
    expect(id1).not.toBe(id2)
  })

  it('applies region crops before hashing and encoding', async () => {
    const h = makeHarness()
    h.service.arm(true)
    analyze(h.service, { region: { x: 0, y: 0, w: 0.5, h: 0.5 } })
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('completed')
    expect(h.backend.encodeCalls[0]).toEqual({ w: W / 2, h: H / 2 })
  })

  it('attaches transcript refs only when the user opted in, current session only', async () => {
    // Second capture must hash differently from the first (solid colors
    // degenerate in aHash), so the provider is really called twice.
    const h = makeHarness([solidImage(), patternImage()])
    h.service.arm(true)
    h.transcript.push({ segmentId: 'seg1', seq: 0, text: 'we opened settings' })

    analyze(h.service, { includeTranscript: false })
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].transcriptRefs).toHaveLength(0)
    // prompt must not contain transcript text when not selected
    expect(JSON.stringify(h.vision.messages[0].messages)).not.toContain('we opened settings')

    h.transcript.push({ segmentId: 'seg2', seq: 1, text: 'the toggles are visible' })
    analyze(h.service, { includeTranscript: true })
    h.vision.release()
    await waitUntil(() => h.events.results[1])
    expect(h.events.results[1].transcriptRefs).toHaveLength(2)
    expect(JSON.stringify(h.vision.messages[1].messages)).toContain('the toggles are visible')
  })

  it('cancels mid-stream: result cancelled, no context write', async () => {
    const h = makeHarness()
    h.service.arm(true)
    const id = analyze(h.service)
    await waitUntil(() => h.events.deltas.length > 0)
    h.service.cancel(id)
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('cancelled')
    expect(h.context.snapshot()).toHaveLength(0)
  })

  it('maps provider failures to error events and an error result (retryable)', async () => {
    const backend = fakeBackend([solidImage()])
    const context = new ContextEngine()
    const failingProvider: AIProvider = {
      id: 'v1',
      label: 'Broken',
      capabilities: () => ({ chat: true, streaming: true, vision: true, transcription: false }),
      // eslint-disable-next-line require-yield
      async *chatStream() {
        throw new ProviderError('Authentication failed — check the API key (401)', 401)
      },
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    const service = new ScreenService({
      backend,
      resolveVision: () => ({ provider: failingProvider, model: 'm', id: 'v1', label: 'Broken' }),
      getRecentTranscript: () => [],
      context,
      armGate: new PermissionGate(5 * 60_000)
    })
    const events = { results: [] as Array<{ status: string; message?: string }>, errors: [] as unknown[] }
    service.bindEvents({
      onPreview: () => undefined,
      onDelta: () => undefined,
      onResult: (e) => events.results.push(e),
      onError: (e) => events.errors.push(e),
      onStatus: () => undefined,
      onMetrics: () => undefined
    })
    service.arm(true)
    const res = service.analyze({ kind: 'screen', question: 'q', includeTranscript: false, includeContext: true })
    expect(res.ok).toBe(true)
    await waitUntil(() => events.results[0])
    expect(events.results[0].status).toBe('error')
    expect(events.results[0].message).toMatch(/401/)
    expect(context.snapshot()).toHaveLength(0)
  })

  it('rejects invalid captured images instead of sending them', async () => {
    const broken = solidImage()
    const h = makeHarness([{ ...broken, rgba: broken.rgba.subarray(0, 50) }])
    h.service.arm(true)
    analyze(h.service)
    await waitUntil(() => h.events.results[0])
    expect(h.events.results[0].status).toBe('error')
    expect(h.events.results[0].message).toMatch(/dimensions|buffer/i)
    expect(h.vision.messages).toHaveLength(0)
  })

  it('clear() resets duplicate detection (same capture analyzed again)', async () => {
    const h = makeHarness()
    h.service.arm(true)
    analyze(h.service)
    h.vision.release()
    await waitUntil(() => h.events.results[0])
    h.service.clear()
    analyze(h.service)
    h.vision.release()
    await waitUntil(() => h.events.results[1])
    // after clear, the identical screen is analyzed again (not a duplicate)
    expect(h.events.results[1].status).toBe('completed')
    expect(h.vision.messages).toHaveLength(2)
  })
})
