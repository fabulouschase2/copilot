/**
 * Main application window (Module G). An ordinary, visible, resizable
 * floating window — always-on-top is a user toggle, not a stealth feature.
 */
import { BrowserWindow, app, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

let mainWindow: BrowserWindow | null = null

/** Remembered window bounds (Part C: position/size persist across restarts). */
function boundsFile(): string {
  return path.join(app.getPath('userData'), 'window-bounds.json')
}

function loadBounds(): { width: number; height: number; x?: number; y?: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsFile(), 'utf-8')) as {
      width?: number
      height?: number
      x?: number
      y?: number
    }
    if (
      typeof raw.width === 'number' && raw.width >= 320 && raw.width <= 4_000 &&
      typeof raw.height === 'number' && raw.height >= 420 && raw.height <= 4_000
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
    /* missing/corrupt: defaults */
  }
  return null
}

function saveBounds(win: BrowserWindow): void {
  try {
    const b = win.getNormalBounds()
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true })
    fs.writeFileSync(boundsFile(), JSON.stringify(b), 'utf-8')
  } catch {
    /* best-effort */
  }
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const saved = loadBounds()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 420,
    height: saved?.height ?? 680,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 320,
    minHeight: 420,
    title: 'Copilot',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.on('close', () => {
    if (!mainWindow?.isDestroyed()) saveBounds(mainWindow as BrowserWindow)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links open in the user's browser, never in-app (keeps the surface small).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function toggleWindowVisible(): void {
  const win = getMainWindow()
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

export function togglePinned(): boolean {
  const win = getMainWindow()
  if (!win) return false
  const next = !win.isAlwaysOnTop()
  win.setAlwaysOnTop(next, 'floating')
  return next
}

export function appUserDataDir(): string {
  return app.getPath('userData')
}
