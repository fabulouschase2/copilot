/**
 * Screen understanding orchestrator (Module B).
 *
 * One-shot, user-initiated captures only: every analysis binds to an explicit
 * request; there are no timers, no continuous capture, and no way for capture
 * to restart after Stop/Clear (consent must be re-armed by the user).
 * Raw images exist only inside main and are released after each request;
 * the ContextEngine receives extracted observations as text, never images.
 */
import { ContextEngine } from '../context-engine'
import { PermissionGate } from '../audio/permission-gate'
import {
  HashRing,
  RawImage,
  averageHash,
  cropImage,
  cropRect,
  DUPLICATE_SIMILARITY_THRESHOLD,
  validateImage
} from './image-hash'
import { ScreenBackend } from './screen-backend'
import { VisionAnalyzer } from '../vision/vision-analyzer'
import { AIProvider, ProviderError } from '../providers/types'
import {
  ScreenAnalysisResult,
  ScreenAnalysisStatus,
  ScreenCaptureRequest,
  ScreenKind
} from '../../../shared/protocol'

export interface ScreenEvents {
  onPreview(e: {
    requestId: string
    dataUrl: string
    width: number
    height: number
    similarityToPrevious: number | null
    duplicate: boolean
  }): void
  onDelta(e: { requestId: string; delta: string }): void
  onResult(e: ScreenAnalysisResult): void
  onError(e: { requestId: string; code: string; message: string }): void
  onStatus(e: { requestId: string; phase: 'capturing' | 'preprocessing' | 'analyzing' }): void
  onMetrics(e: {
    requestId: string
    captureMs: number | null
    preprocessMs: number
    ttftMs: number | null
    totalMs: number
    peakImageBytes: number
    duplicateDetectionMs: number
  }): void
}

export interface ScreenDeps {
  backend: ScreenBackend
  /** Resolves a vision-capable provider; null when none is configured/enabled. */
  resolveVision: () => { provider: AIProvider; model: string; id: string; label: string } | null
  getRecentTranscript: () => Array<{ segmentId: string; seq: number; text: string }>
  /** Active session id, so screen observations are scoped to their session. */
  getSessionId?: () => string | null
  context: ContextEngine
  /** Consent gate for screen analysis (longer TTL than capture-permission). */
  armGate: PermissionGate
  now?: () => number
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // encoded payload guard

interface ActiveRequest {
  id: string
  abort: AbortController
  startedAt: number
}

export class ScreenService {
  private events: ScreenEvents = {
    onPreview: () => undefined,
    onDelta: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onStatus: () => undefined,
    onMetrics: () => undefined
  }
  private active: ActiveRequest | null = null
  private hashRing = new HashRing(8)
  private analyzer = new VisionAnalyzer()

  constructor(private deps: ScreenDeps) {}

  bindEvents(events: ScreenEvents): void {
    this.events = events
  }

  /** Consent switch: captures require an unexpired arm. Stop/Clear revokes. */
  arm(enabled: boolean): void {
    if (enabled) this.deps.armGate.arm('screen')
    else this.deps.armGate.revokeAll()
  }

  isArmed(): boolean {
    return this.deps.armGate.isArmed('screen')
  }

  listSources(kind: ScreenKind): Promise<{ ok: boolean; sources?: Array<{ id: string; name: string; thumbnailDataUrl: string }>; message?: string }> {
    if (!this.isArmed()) {
      return Promise.resolve({ ok: false, message: 'Screen analysis is not enabled. Enable it first.' })
    }
    return this.deps.backend
      .listSources(kind)
      .then((sources) => ({ ok: true, sources }))
      .catch((err) => ({ ok: false, message: `Could not list sources: ${text(err)}` }))
  }

  clear(): void {
    this.hashRing.clear()
  }

  /** Returns the requestId on success; the result arrives via events. */
  analyze(req: ScreenCaptureRequest): { ok: true; requestId: string } | { ok: false; message: string } {
    if (!this.isArmed()) {
      return { ok: false, message: 'Screen analysis is not enabled. Enable it first.' }
    }
    if (this.active) {
      return { ok: false, message: 'An analysis is already running. Cancel it first.' }
    }
    const vision = this.deps.resolveVision()
    if (!vision) {
      return {
        ok: false,
        message: 'No vision-capable provider configured. Enable a chat provider with "model accepts images".'
      }
    }
    const requestId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const abort = new AbortController()
    this.active = { id: requestId, abort, startedAt: this.now() }

    const transcriptRefs = req.includeTranscript ? this.deps.getRecentTranscript() : []
    void this.run(requestId, req, vision, transcriptRefs, abort)
    return { ok: true, requestId }
  }

  cancel(requestId: string): void {
    if (this.active?.id === requestId) this.active.abort.abort()
  }

  private async run(
    requestId: string,
    req: ScreenCaptureRequest,
    vision: { provider: AIProvider; model: string; id: string; label: string },
    transcriptRefs: Array<{ segmentId: string; seq: number; text: string }>,
    abort: AbortController
  ): Promise<void> {
    const startedAt = this.now()
    let captureMs: number | null = null
    let preprocessMs = 0
    let ttftMs: number | null = null
    let peakImageBytes = 0
    let duplicateDetectionMs = 0

    const finish = (status: ScreenAnalysisStatus, observations: string, message?: string): void => {
      this.active = null
      const result: ScreenAnalysisResult = {
        requestId,
        status,
        question: req.question,
        observations,
        provider: status === 'completed' ? { id: vision.id, label: vision.label, model: vision.model } : null,
        processing: {
          captureMs,
          preprocessMs,
          ttftMs,
          totalMs: Math.round(this.now() - startedAt),
          sentWidth: lastDimensions?.width ?? null,
          sentHeight: lastDimensions?.height ?? null,
          similarityToPrevious,
          duplicate: status === 'duplicate'
        },
        transcriptRefs,
        message
      }
      this.events.onResult(result)
      this.events.onMetrics({
        requestId,
        captureMs,
        preprocessMs,
        ttftMs,
        totalMs: result.processing.totalMs,
        peakImageBytes,
        duplicateDetectionMs
      })
    }

    let similarityToPrevious: number | null = null
    let lastDimensions: { width: number; height: number } | null = null

    try {
      // 1. Capture (main process, one shot).
      this.events.onStatus({ requestId, phase: 'capturing' })
      const t0 = this.now()
      const captured = await this.deps.backend.capture(req.kind, req.sourceId)
      captureMs = Math.round(this.now() - t0)
      peakImageBytes = Math.max(peakImageBytes, captured.image.rgba.length)
      if (abort.signal.aborted) return finish('cancelled', '')

      // 2. Preprocess: optional region crop, validation, duplicate detection.
      this.events.onStatus({ requestId, phase: 'preprocessing' })
      const t1 = this.now()
      let image: RawImage = captured.image
      if (req.region) {
        const rect = cropRect(image.width, image.height, req.region)
        if (!rect) return finish('error', '', 'The selected region is empty.')
        image = cropImage(image, rect)
      }
      const validated = validateImage(image)
      if (!validated.ok) return finish('error', '', validated.message)

      const t2 = this.now()
      const hash = averageHash(image)
      similarityToPrevious = this.hashRing.bestSimilarity(hash)
      const duplicate = similarityToPrevious >= DUPLICATE_SIMILARITY_THRESHOLD
      this.hashRing.push(hash)
      duplicateDetectionMs = Math.round(this.now() - t2)
      preprocessMs = Math.round(this.now() - t1)

      this.events.onPreview({
        requestId,
        dataUrl: captured.previewDataUrl,
        width: image.width,
        height: image.height,
        similarityToPrevious,
        duplicate
      })

      if (duplicate) return finish('duplicate', '')

      // For an analysis we re-encode the (possibly cropped) region: the
      // backend's full-frame JPEG does not cover crops, so the crop path
      // re-encodes RGBA through the backend-aware hook when needed.
      let jpegBase64 = req.region ? this.deps.backend.encode(image) : captured.jpegBase64
      if (jpegBase64.length * 0.75 > MAX_IMAGE_BYTES) {
        return finish('error', '', 'The encoded image exceeds the payload limit.')
      }
      peakImageBytes = Math.max(peakImageBytes, jpegBase64.length)
      if (abort.signal.aborted) return finish('cancelled', '')

      // 3. Analyze (streaming, vision provider).
      this.events.onStatus({ requestId, phase: 'analyzing' })
      const transcriptContext =
        transcriptRefs.length > 0
          ? transcriptRefs.map((s) => `[${s.seq}] ${s.text}`).join('\n')
          : undefined

      let observations = ''
      try {
        observations = await this.analyzer.analyze(
          {
            provider: vision.provider,
            model: vision.model,
            imageJpegBase64: jpegBase64,
            question: req.question,
            transcriptContext,
            signal: abort.signal
          },
          {
            onDelta: (d) => this.events.onDelta({ requestId, delta: d }),
            onFirstToken: (ms) => {
              ttftMs = Math.round(ms)
            }
          }
        )
      } catch (err) {
        if (abort.signal.aborted) return finish('cancelled', '')
        const message = err instanceof ProviderError ? err.message : `Vision analysis failed: ${text(err)}`
        this.events.onError({ requestId, code: 'provider', message })
        return finish('error', '', message)
      }
      jpegBase64 = '' // release the encoded payload promptly

      if (req.includeContext && observations.trim().length > 0) {
        this.deps.context.add({
          id: requestId,
          kind: 'screen',
          text: `Screen analysis — Q: ${req.question}\nA: ${observations.trim()}`,
          timestamp: Date.now(),
          sessionId: this.deps.getSessionId?.() ?? undefined
        })
      }
      finish('completed', observations)
    } catch (err) {
      if (abort.signal.aborted) return finish('cancelled', '')
      const code = /No capture source/.test(String(err)) ? 'no-source' : 'internal'
      this.events.onError({ requestId, code, message: text(err) })
      finish('error', '', text(err))
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now()
  }
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
