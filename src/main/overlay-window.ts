/**
 * Private desktop overlay (Phase 6).
 *
 * A frameless, always-on-top window that shows live captions and the latest
 * answer while the user shares something else. On Windows the window is
 * excluded from capture with `WDA_EXCLUDEFROMCAPTURE` (see
 * services/overlay/display-affinity.ts) so supported recorders and screen
 * shares do not include it in their output.
 *
 * Honesty rules enforced here:
 * - `exclusionActive` is read back from the OS, never assumed from settings.
 * - Unsupported platforms/builds keep the overlay usable but say so.
 * - Failures are surfaced with the Win32 code instead of being swallowed.
 */
import { BrowserWindow, screen } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  OverlayContent,
  OverlayContentSchema,
  OverlaySetRequest,
  OverlaySettings,
  OverlayStateInfo
} from '../shared/protocol'
import { WindowsCaptureExclusion } from './services/overlay/display-affinity'
import { deriveOverlayState } from './services/overlay/overlay-state'

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 230
const MIN_WIDTH = 360
const MIN_HEIGHT = 120

interface Bounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface OverlayControllerDeps {
  userDataDir: string
  preloadPath: string
  /** Vite dev server base URL (dev) or null (packaged). */
  devUrl: string | null
  /** Absolute path to out/renderer/overlay.html (packaged). */
  overlayHtml: string
  getSettings: () => OverlaySettings
  /** Persist a settings patch; returns the stored settings. */
  persist: (patch: OverlaySetRequest) => OverlaySettings
  /** Notified whenever derived state changes (main window mirrors it). */
  onStateChange?: (state: OverlayStateInfo) => void
}

export class OverlayController {
  private window: BrowserWindow | null = null
  private readonly exclusion: WindowsCaptureExclusion
  private lastError: string | null = null
  private lastErrorCode: number | null = null
  private affinity: number | null = null
  /** Last answer, replayed when the overlay opens mid-answer. */
  private lastAnswer: OverlayContent | null = null

  constructor(private readonly deps: OverlayControllerDeps) {
    this.exclusion = new WindowsCaptureExclusion()
  }

  getState(): OverlayStateInfo {
    const settings = this.deps.getSettings()
    const visible = this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
    // Re-read the OS value each time: the window may have been re-created or
    // the OS may have refused the flag since we last asked.
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.affinity = this.exclusion.read(this.window.getNativeWindowHandle())
      } catch {
        this.affinity = null
      }
    } else {
      this.affinity = null
    }
    return deriveOverlayState({
      enabled: settings.enabled,
      visible,
      captureExcluded: settings.captureExcluded,
      affinity: this.affinity,
      support: this.exclusion.support,
      supportMessage: this.exclusion.supportMessage,
      opacity: settings.opacity,
      fontSize: settings.fontSize,
      showCaptions: settings.showCaptions,
      error: this.lastError,
      lastErrorCode: this.lastErrorCode
    })
  }

  /** Apply a settings patch, (re)creating or hiding the window as needed. */
  set(patch: OverlaySetRequest): OverlayStateInfo {
    const stored = this.deps.persist(patch)
    if (stored.enabled) this.ensureWindow()
    else this.hideWindow()
    this.applyToWindow()
    return this.emit()
  }

  /** Hide without clearing the user's preference history for styling. */
  hide(): void {
    this.deps.persist({ enabled: false })
    this.hideWindow()
    this.emit()
  }

  /** Called once at startup so a remembered overlay reappears. */
  restore(): void {
    const settings = this.deps.getSettings()
    if (settings.enabled) {
      this.ensureWindow()
      this.applyToWindow()
    }
    this.emit()
  }

  /** Show a piece of content on the overlay (no-op when disabled). */
  push(content: OverlayContent): void {
    const parsed = OverlayContentSchema.safeParse(content)
    if (!parsed.success) return
    if (parsed.data.kind === 'answer') this.lastAnswer = parsed.data
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('overlay:content', parsed.data)
      })
      return
    }
    win.webContents.send('overlay:content', parsed.data)
  }

  /**
   * Mirror live session events to the overlay. Called for every event the
   * main window receives, so the overlay needs no provider access of its own.
   */
  mirror(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    if (channel === 'transcript:segment') {
      const p = payload as { text?: unknown; source?: unknown; purpose?: unknown }
      if (typeof p?.text !== 'string' || p.text.length === 0) return
      if (p.purpose === 'practice') return
      this.push({
        kind: 'caption',
        text: p.text,
        source: p.source === 'mic' ? 'mic' : 'system'
      })
      return
    }
    if (channel === 'mode:result') {
      const p = payload as { channel?: unknown; status?: unknown; text?: unknown }
      if (p?.channel !== 'interview' || typeof p.text !== 'string' || p.text.length === 0) return
      if (p.status !== undefined && p.status !== 'completed') return
      this.push({ kind: 'answer', text: p.text })
    }
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  // ── internals ─────────────────────────────────────────────────────────

  private boundsFile(): string {
    return path.join(this.deps.userDataDir, 'overlay-bounds.json')
  }

  private loadBounds(): Bounds | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.boundsFile(), 'utf-8')) as Partial<Bounds>
      if (
        typeof raw.width === 'number' && raw.width >= MIN_WIDTH && raw.width <= 4_000 &&
        typeof raw.height === 'number' && raw.height >= MIN_HEIGHT && raw.height <= 4_000
      ) {
        return {
          width: Math.round(raw.width),
          height: Math.round(raw.height),
          ...(typeof raw.x === 'number' && typeof raw.y === 'number'
            ? { x: Math.round(raw.x), y: Math.round(raw.y) }
            : {})
        }
      }
    } catch {
      /* first run */
    }
    return null
  }

  private saveBounds(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    try {
      fs.mkdirSync(path.dirname(this.boundsFile()), { recursive: true })
      fs.writeFileSync(this.boundsFile(), JSON.stringify(win.getNormalBounds()), 'utf-8')
    } catch {
      /* best-effort */
    }
  }

  private defaultBounds(): Bounds {
    const area = screen.getPrimaryDisplay().workArea
    return {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      x: Math.round(area.x + (area.width - DEFAULT_WIDTH) / 2),
      y: Math.round(area.y + area.height - DEFAULT_HEIGHT - 72)
    }
  }

  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return
    const saved = this.loadBounds() ?? this.defaultBounds()
    const win = new BrowserWindow({
      width: saved.width,
      height: saved.height,
      ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: 'Copilot Overlay',
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // Keep captions flowing while the main window is in the background.
        backgroundThrottling: false
      }
    })
    this.window = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setMenuBarVisibility(false)

    win.on('resize', () => this.saveBounds())
    win.on('move', () => this.saveBounds())
    win.on('show', () => this.applyExclusion())
    win.on('closed', () => {
      this.window = null
      // Closing the overlay is a user action: remember it as "off".
      try {
        this.deps.persist({ enabled: false })
      } catch {
        /* ignore */
      }
      this.emit()
    })

    const devUrl = this.deps.devUrl
    if (devUrl) {
      void win.loadURL(`${devUrl}/overlay.html`)
    } else {
      void win.loadFile(this.deps.overlayHtml)
    }

    win.once('ready-to-show', () => {
      if (!this.window || this.window.isDestroyed()) return
      this.applyToWindow()
      win.showInactive()
      this.applyExclusion()
      if (this.lastAnswer) this.push(this.lastAnswer)
      this.emit()
    })

    // The renderer subscribes after React mounts, which is later than
    // ready-to-show; send the authoritative state again once the document is
    // ready so the overlay never sits on "checking…".
    win.webContents.on('did-finish-load', () => {
      if (!this.window || this.window.isDestroyed()) return
      this.applyToWindow()
      if (this.lastAnswer) this.push(this.lastAnswer)
    })
  }

  private hideWindow(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.saveBounds()
      this.window.hide()
    }
  }

  /** Opacity + font size reach the overlay renderer through overlay:state. */
  private applyToWindow(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const settings = this.deps.getSettings()
    try {
      win.setOpacity(settings.opacity)
    } catch {
      /* opacity unsupported: leave the default */
    }
    this.applyExclusion()
    win.webContents.send('overlay:state', this.getState())
  }

  /**
   * Apply or clear capture exclusion on the overlay window only. Never
   * touches the main window or any other application's windows.
   */
  private applyExclusion(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const settings = this.deps.getSettings()
    if (!settings.enabled) return
    let outcome
    try {
      outcome = this.exclusion.apply(win.getNativeWindowHandle(), settings.captureExcluded)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Capture exclusion failed.'
      this.lastErrorCode = null
      this.affinity = null
      return
    }
    this.affinity = outcome.affinity
    if (outcome.ok) {
      this.lastError = null
      this.lastErrorCode = null
    } else if (settings.captureExcluded) {
      // Only a failed *exclusion* is an error; "capturable" is a valid state.
      this.lastError = outcome.message
      this.lastErrorCode = outcome.errorCode
    } else {
      this.lastError = null
      this.lastErrorCode = null
    }
  }

  private emit(): OverlayStateInfo {
    const state = this.getState()
    this.deps.onStateChange?.(state)
    return state
  }
}
