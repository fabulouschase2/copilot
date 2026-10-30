/**
 * Question read-aloud (practice interviews) via the renderer's built-in
 * speech synthesis (Chromium Web Speech API → Windows voices). Nothing is
 * sent anywhere: this is offline OS speech. Voices depend on what the user
 * has installed; we expose rate + voice matching so it degrades gracefully.
 */

export interface SpeakHandle {
  cancel(): void
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

/** Speak text; resolves when speech finishes (or is cancelled). */
export function speak(text: string, opts: { lang?: string; rate?: number } = {}): SpeakHandle {
  if (!ttsSupported()) return { cancel: () => undefined }
  const u = new SpeechSynthesisUtterance(text)
  const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : 'en-US'
  u.lang = lang
  u.rate = opts.rate ?? 1
  const voice = pickVoice(lang)
  if (voice) u.voice = voice
  window.speechSynthesis.cancel() // never queue over a previous question
  window.speechSynthesis.speak(u)
  return {
    cancel: () => window.speechSynthesis.cancel()
  }
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel()
}
