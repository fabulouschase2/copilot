/**
 * Renderer-side audio capture (Module A sensor layer).
 *
 * The renderer is an untrusted sensor: it acquires the OS stream, resamples
 * to 16 kHz mono PCM16, and forwards ~100 ms chunks over IPC. It holds no
 * credentials, does no STT, and persists nothing. VAD, provider calls, and
 * transcript state live in the main process.
 */
import { TranscriptSource } from '../../../shared/protocol'

const TARGET_RATE = 16_000

export interface CaptureSession {
  stop(): void
  /** Fires when a track ends on its own (device disconnected / stream ended). */
  onEnded(cb: () => void): void
}

export class CaptureError extends Error {
  constructor(
    readonly code: 'denied' | 'no-device' | 'no-audio-track' | 'worklet' | 'unknown',
    message: string
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

export async function startCapture(
  source: TranscriptSource,
  deviceId: string | undefined,
  sendChunk: (seq: number, b64: string) => void
): Promise<CaptureSession> {
  let stream: MediaStream
  try {
    stream =
      source === 'mic'
        ? await navigator.mediaDevices.getUserMedia({
            audio: deviceId ? { deviceId: { exact: deviceId } } : true,
            video: false
          })
        : await navigator.mediaDevices.getDisplayMedia({
            video: true, // Windows loopback requires a screen selection; stopped below
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotAllowedError') throw new CaptureError('denied', 'Microphone or capture permission was denied.')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CaptureError('no-device', 'No audio input device found.')
    }
    throw new CaptureError('unknown', `Could not start capture: ${name || 'unknown error'}`)
  }

  // Loopback capture carries a video track we immediately stop; only audio flows.
  for (const track of stream.getVideoTracks()) track.stop()
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new CaptureError(
      'no-audio-track',
      source === 'system'
        ? 'No system audio was shared. On Windows, enable "Share system audio" or use a loopback-capable setup.'
        : 'The selected device has no audio track.'
    )
  }

  const endedHandler = (): void => endedCallbacks.forEach((cb) => cb())
  const endedCallbacks: Array<() => void> = []
  audioTracks[0].addEventListener('ended', endedHandler)

  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    throw new CaptureError('unknown', `AudioContext failed: ${String(err)}`)
  }

  let workletFailed = false
  let processor: AudioWorkletNode | ScriptProcessorNode | null = null
  const sourceNode = ctx.createMediaStreamSource(stream)
  let seq = 0
  let stopped = false

  const handleBatch = (blocks: Float32Array[]): void => {
    if (stopped) return
    const flat = flatten(blocks)
    const resampled = downsample(flat, ctx.sampleRate, TARGET_RATE)
    const b64 = floatToPcm16Base64(resampled)
    if (b64.length > 0) sendChunk(seq++, b64)
  }

  try {
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    const node = new AudioWorkletNode(ctx, 'pcm-collector')
    node.port.onmessage = (ev) => handleBatch(ev.data as Float32Array[])
    sourceNode.connect(node)
    // Worklet nodes need a destination to run; use a zero-gain sink so nothing
    // is played back (no echo, no monitoring leak).
    const sink = ctx.createGain()
    sink.gain.value = 0
    node.connect(sink)
    sink.connect(ctx.destination)
    processor = node
  } catch {
    workletFailed = true
  }

  if (workletFailed) {
    // Fallback for hosts where AudioWorklet module loading fails.
    const legacy = ctx.createScriptProcessor(4096, 1, 1)
    let acc: Float32Array[] = []
    legacy.onaudioprocess = (ev) => {
      acc.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
      if (acc.length >= 12) {
        handleBatch(acc)
        acc = []
      }
    }
    sourceNode.connect(legacy)
    const sink = ctx.createGain()
    sink.gain.value = 0
    legacy.connect(sink)
    sink.connect(ctx.destination)
    processor = legacy
  }

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      if (processor) {
        try {
          processor.disconnect()
        } catch {
          /* already disconnected */
        }
      }
      try {
        sourceNode.disconnect()
      } catch {
        /* already disconnected */
      }
      void ctx.close()
      stream.getTracks().forEach((t) => t.stop())
      audioTracks[0].removeEventListener('ended', endedHandler)
    },
    onEnded(cb: () => void): void {
      endedCallbacks.push(cb)
    }
  }
}

function flatten(blocks: Float32Array[]): Float32Array {
  let total = 0
  for (const b of blocks) total += b.length
  const out = new Float32Array(total)
  let offset = 0
  for (const b of blocks) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

/** Naive linear resampler — adequate for speech at these rates and cheap. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function floatToPcm16Base64(input: Float32Array): string {
  const bytes = new Uint8Array(input.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export async function listMicDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}
