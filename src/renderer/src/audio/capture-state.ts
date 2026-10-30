/**
 * Live renderer-side capture state for the audio diagnostics view.
 * `startCapture` reports here automatically — panels need no changes.
 * Contains no audio content: only counters, timestamps, and sample rate.
 */

export interface CaptureDiagnosticsState {
  /** A capture stream is open in the renderer right now. */
  active: boolean
  source: 'mic' | 'system' | null
  /** AudioContext sample rate (before resampling to 16 kHz). */
  sampleRate: number | null
  /** PCM chunks handed to IPC since capture start. */
  chunksSent: number
  /** Epoch ms of the last chunk handed to IPC. */
  lastChunkAt: number | null
  startedAt: number | null
  lastError: string | null
}

const listeners = new Set<() => void>()

export const captureDiagnostics: CaptureDiagnosticsState = {
  active: false,
  source: null,
  sampleRate: null,
  chunksSent: 0,
  lastChunkAt: null,
  startedAt: null,
  lastError: null
}

export function subscribeCaptureDiagnostics(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function resetCaptureDiagnostics(patch: Partial<CaptureDiagnosticsState>): void {
  Object.assign(captureDiagnostics, patch)
  listeners.forEach((l) => l())
}
