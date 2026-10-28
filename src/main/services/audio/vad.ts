/**
 * Energy-based voice activity detector (Module A).
 *
 * Deliberately simple and CPU-cheap: RMS with hysteresis, a pre-roll ring so
 * speech onsets are not clipped, a hangover time so word gaps do not split
 * utterances, and a max-segment duration to bound STT latency. Heavier
 * neural VAD can replace this class behind the same interface later.
 */
import { rmsDbfs } from './pcm'

export interface VadOptions {
  sampleRate?: number
  /** Open the gate when RMS exceeds this dBFS for openMs. */
  thresholdDb?: number
  /** Consecutive ms above threshold required to open. */
  openMs?: number
  /** Consecutive ms below threshold required to close. */
  hangoverMs?: number
  /** Pre-roll kept before speech onset. */
  prerollMs?: number
  /** Force-close after this much continuous speech. */
  maxSegmentMs?: number
}

export interface VadEvents {
  /** A speech segment ended. startMs/endMs are on the fed-audio timeline. */
  onSegment(segment: { pcm: Int16Array; startMs: number; endMs: number }): void
  onSpeechActiveChange(active: boolean): void
}

interface RingBuffer {
  capacity: number
  data: Int16Array
  length: number
}

export class EnergyVad {
  private readonly sampleRate: number
  private readonly thresholdDb: number
  private readonly openSamples: number
  private readonly hangoverSamples: number
  private readonly maxSegmentSamples: number
  private readonly preroll: RingBuffer

  private aboveCount = 0
  private belowCount = 0
  private speechActive = false
  private segmentStartSample = 0
  private segmentPcm: Int16Array[] = []
  private totalSamples = 0
  private closed = false

  constructor(
    private events: VadEvents,
    opts: VadOptions = {}
  ) {
    this.sampleRate = opts.sampleRate ?? 16_000
    this.thresholdDb = opts.thresholdDb ?? -45
    this.openSamples = Math.ceil(((opts.openMs ?? 120) / 1000) * this.sampleRate)
    this.hangoverSamples = Math.ceil(((opts.hangoverMs ?? 700) / 1000) * this.sampleRate)
    this.maxSegmentSamples = Math.ceil(((opts.maxSegmentMs ?? 20_000) / 1000) * this.sampleRate)
    const prerollSamples = Math.ceil(((opts.prerollMs ?? 300) / 1000) * this.sampleRate)
    this.preroll = { capacity: prerollSamples, data: new Int16Array(prerollSamples), length: 0 }
  }

  /** True between an open and its close (including hangover). */
  get active(): boolean {
    return this.speechActive
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    // Flushing (emit=true): callers such as pause() rely on receiving the
    // half-open utterance rather than silently discarding it.
    this.closeSegment(true)
  }

  feed(pcm: Int16Array): void {
    if (this.closed) return
    let offset = 0
    while (offset < pcm.length) {
      // 10 ms analysis frames at the VAD sample rate.
      const frameSamples = Math.floor(this.sampleRate / 100)
      const take = Math.min(frameSamples, pcm.length - offset)
      const frame = pcm.subarray(offset, offset + take)
      this.processFrame(frame)
      offset += take
    }
  }

  private processFrame(frame: Int16Array): void {
    const db = rmsDbfs(frame)
    const above = db > this.thresholdDb

    if (!this.speechActive) {
      this.prerollPush(frame)
      if (above) {
        this.aboveCount += frame.length
        if (this.aboveCount >= this.openSamples) {
          this.speechActive = true
          this.belowCount = 0
          this.segmentStartSample = this.totalSamples
          // Include the pre-roll so the onset is not clipped.
          this.segmentPcm = [this.prerollCopy()]
          this.segmentPcm.push(frame)
          this.events.onSpeechActiveChange(true)
        }
      } else {
        this.aboveCount = 0
      }
    } else {
      this.segmentPcm.push(frame)
      if (!above) {
        this.belowCount += frame.length
        if (this.belowCount >= this.hangoverSamples) {
          this.closeSegment(true)
        }
      } else {
        this.belowCount = 0
      }
      if (this.speechActive && this.totalSamples + frame.length - this.segmentStartSample >= this.maxSegmentSamples) {
        this.closeSegment(true)
      }
    }

    this.totalSamples += frame.length
  }

  private prerollPush(frame: Int16Array): void {
    const ring = this.preroll.data
    if (frame.length >= ring.length) {
      ring.set(frame.subarray(frame.length - ring.length))
      this.preroll.length = ring.length
      return
    }
    const shift = Math.min(this.preroll.length, ring.length - frame.length)
    ring.copyWithin(0, this.preroll.length - shift, this.preroll.length)
    ring.set(frame, shift)
    this.preroll.length = Math.min(this.preroll.length + frame.length, ring.length)
  }

  private prerollCopy(): Int16Array {
    return this.preroll.data.slice(0, this.preroll.length)
  }

  private closeSegment(emit: boolean): void {
    if (this.speechActive) {
      const pcm = concat(this.segmentPcm)
      const endSample = this.totalSamples
      const startMs = Math.max(0, Math.round(((endSample - pcm.length) / this.sampleRate) * 1000))
      const endMs = Math.round((endSample / this.sampleRate) * 1000)
      if (emit && pcm.length > 0) this.events.onSegment({ pcm, startMs, endMs })
      this.segmentPcm = []
      this.speechActive = false
      this.aboveCount = 0
      this.belowCount = 0
      this.events.onSpeechActiveChange(false)
    }
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
