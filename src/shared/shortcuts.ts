/**
 * Centralized shortcut registry (Stage 10 UI rebuild).
 *
 * Single source of truth for keyboard shortcuts so global registrations and
 * in-app handlers can never conflict. Global shortcuts are registered in the
 * main process; in-app ones are matched by the renderer against keydown
 * events (with the ctrl-notation normalized for Windows/Linux).
 */

export interface ShortcutDef {
  id: string
  /** Normalized chord, e.g. 'ctrl+alt+c', 'ctrl+enter', 'escape'. */
  chord: string
  /** Global = registered via Electron globalShortcut (works app-unfocused). */
  scope: 'global' | 'in-app'
  label: string
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'toggle-window', chord: 'ctrl+alt+c', scope: 'global', label: 'Show/hide the copilot window' },
  { id: 'read-screen', chord: 'ctrl+alt+r', scope: 'global', label: 'Read the current screen' },
  { id: 'end-session', chord: 'ctrl+alt+e', scope: 'global', label: 'End the active session' },
  { id: 'answer', chord: 'ctrl+enter', scope: 'in-app', label: 'Generate the answer' },
  { id: 'shorter', chord: 'ctrl+shift+arrowdown', scope: 'in-app', label: 'Make the answer shorter' },
  { id: 'rephrase', chord: 'ctrl+shift+arrowup', scope: 'in-app', label: 'Rephrase the answer' },
  { id: 'copy-answer', chord: 'ctrl+shift+c', scope: 'in-app', label: 'Copy the current answer' },
  { id: 'clear-qa', chord: 'ctrl+shift+backspace', scope: 'in-app', label: 'Clear question and answer' },
  { id: 'stop', chord: 'escape', scope: 'in-app', label: 'Stop generating' }
]

/** Normalize a KeyboardEvent into the registry's chord notation. */
export function eventChord(e: {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  key: string
}): string {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(key)
  return parts.join('+')
}

/** Look up a shortcut id for a normalized chord (in-app scope only). */
export function matchInAppShortcut(chord: string): ShortcutDef | undefined {
  const chordLC = chord.toLowerCase()
  return SHORTCUTS.find((s) => s.scope === 'in-app' && s.chord === chordLC)
}

/** Global chords as Electron expects them (e.g. 'Ctrl+Alt+C'). */
export function electronAccelerators(): Array<{ id: string; accelerator: string }> {
  return SHORTCUTS.filter((s) => s.scope === 'global').map((s) => ({
    id: s.id,
    accelerator: s.chord
      .split('+')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('+')
  }))
}
