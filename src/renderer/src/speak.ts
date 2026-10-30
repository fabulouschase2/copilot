/**
 * Question read-aloud (practice interviews) via the renderer's built-in
 * speech synthesis (Chromium Web Speech API → Windows voices). Nothing is
 * sent anywhere: this is offline OS speech. Voices depend on what the user
 * has installed; we expose rate + voice matching so it degrades gracefully.
 */

export interface SpeakHandle {
  cancel(): void
}

export interface SpeakOptions {
  lang?: string
  rate?: number
  /** Fired when playback actually starts (voices may load async). */
  onStart?: () => void
  /** Fired when playback finishes, is cancelled, or fails. */
  onEnd?: () => void
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Best-effort voice match: exact lang → lang prefix → default voice. */
export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null
  const voices = window.speechSynthesis.getVoices()
  if (voices.length === 0) return null
  const want = lang.toLowerCase()
  const exact = voices.find((v) => v.lang.toLowerCase().replace('_', '-') === want)
  if (exact) return exact
  const prefix = want.split('-')[0]
  const loose = voices.find((v) => v.lang.toLowerCase().startsWith(prefix))
  return loose ?? voices[0]
}

/**
 * Speak text; the returned handle cancels playback. onStart/onEnd let the
 * caller guard the capture path (e.g. mute the practice mic while the
 * interviewer voice is playing, so the app never transcribes its own
 * question as the user's answer).
 */
export function speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
  if (!ttsSupported()) {
    opts.onEnd?.()
    return { cancel: () => undefined }
  }
  const u = new SpeechSynthesisUtterance(text)
  const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : 'en-US'
  u.lang = lang
  u.rate = opts.rate ?? 1
  const voice = pickVoice(lang)
  if (voice) u.voice = voice
  let started = false
  const finish = (): void => {
    if (!started) return
    started = false
    opts.onEnd?.()
  }
  u.onstart = () => {
    started = true
    opts.onStart?.()
  }
  u.onend = finish
  u.onerror = finish
  // If a voice is instantly unavailable the events above may never fire.
  window.speechSynthesis.cancel() // never queue over a previous question
  window.speechSynthesis.speak(u)
  return {
    cancel: () => {
      window.speechSynthesis.cancel()
      finish()
    }
  }
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel()
}
