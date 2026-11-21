/**
 * Pure overlay state logic — no Electron, no native code — so the Windows
 * capture-exclusion contract can be unit-tested without a GUI.
 *
 * The overlay is a *visible* window. What is optional is whether screen
 * capture APIs include it: Windows exposes `WDA_EXCLUDEFROMCAPTURE` for that,
 * and we always report the OS-confirmed affinity instead of claiming success.
 *
 * Shapes and constants live in the shared IPC contract so the renderer sees
 * exactly the same types the main process derives.
 */
import {
  AffinitySupport,
  MIN_BUILD_EXCLUDEFROMCAPTURE,
  OverlayStateInfo,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE
} from '../../../shared/protocol'

export {
  MIN_BUILD_EXCLUDEFROMCAPTURE,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE
}
export type { AffinitySupport, OverlayStateInfo }

export interface SupportAssessment {
  support: AffinitySupport
  /** Human-readable explanation shown in the UI; never optimistic. */
  message: string
}

/** `os.release()` reports Windows 11 as `10.0.22000`; only the build matters. */
export function parseWindowsBuild(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/.exec(release.trim())
  if (!match) return null
  const build = Number(match[1])
  return Number.isFinite(build) && build > 0 ? build : null
}

export function assessSupport(
  platform: string,
  release: string,
  bindingAvailable: boolean
): SupportAssessment {
  if (platform !== 'win32') {
    return {
      support: 'unsupported-platform',
      message:
        'Capture exclusion is implemented for Windows only. The overlay still works on this platform, but recorder applications may capture it.'
    }
  }
  const build = parseWindowsBuild(release)
  if (build === null) {
    return {
      support: 'unsupported-os',
      message: `Could not read the Windows build from "${release}", so capture exclusion was not attempted.`
    }
  }
  if (build < MIN_BUILD_EXCLUDEFROMCAPTURE) {
    return {
      support: 'unsupported-os',
      message: `Windows build ${build} predates build ${MIN_BUILD_EXCLUDEFROMCAPTURE} (Windows 10 version 2004), which introduced WDA_EXCLUDEFROMCAPTURE. The overlay works locally but will appear in captures.`
    }
  }
  if (!bindingAvailable) {
    return {
      support: 'binding-unavailable',
      message:
        'The native Windows binding (koffi) is not installed, so capture exclusion cannot be applied. Reinstall dependencies and restart Copilot.'
    }
  }
  return {
    support: 'supported',
    message: `Windows build ${build} supports WDA_EXCLUDEFROMCAPTURE.`
  }
}

export function describeAffinity(affinity: number | null): string {
  switch (affinity) {
    case WDA_EXCLUDEFROMCAPTURE:
      return 'excluded from capture'
    case WDA_NONE:
      return 'capturable'
    case WDA_MONITOR:
      return 'monitor-only (blanked in captures)'
    default:
      return affinity === null ? 'unknown' : `unrecognised affinity 0x${affinity.toString(16)}`
  }
}

export interface DeriveOverlayStateInput {
  enabled: boolean
  visible: boolean
  captureExcluded: boolean
  affinity: number | null
  support: AffinitySupport
  supportMessage: string
  opacity: number
  fontSize: number
  showCaptions: boolean
  error: string | null
  lastErrorCode: number | null
}

/**
 * Single source of truth for what the UI may claim. A requested exclusion is
 * never reported as active unless the OS echoes back the exact flag.
 */
export function deriveOverlayState(input: DeriveOverlayStateInput): OverlayStateInfo {
  const exclusionActive = input.affinity === WDA_EXCLUDEFROMCAPTURE
  return {
    enabled: input.enabled,
    visible: input.visible,
    captureExcluded: input.captureExcluded,
    affinity: input.affinity,
    exclusionActive,
    exclusionUnverified: input.captureExcluded && !exclusionActive,
    support: input.support,
    supportMessage: input.supportMessage,
    opacity: input.opacity,
    fontSize: input.fontSize,
    showCaptions: input.showCaptions,
    error: input.error,
    lastErrorCode: input.lastErrorCode
  }
}

/**
 * Win32 error codes worth naming when SetWindowDisplayAffinity fails.
 * Anything else is reported numerically — never guessed.
 */
export function explainWin32Error(code: number | null): string {
  switch (code) {
    case 0:
      return 'The call reported failure without a Win32 error code.'
    case 5:
      return 'Access denied (error 5). The window handle may not belong to this process.'
    case 87:
      return 'Invalid parameter (error 87). The window handle was rejected.'
    default:
      return code === null ? 'The call failed and reported no error code.' : `Win32 error ${code}.`
  }
}

/** HWND from BrowserWindow.getNativeWindowHandle() (4 or 8 bytes, LE). */
export function readHwnd(handle: Buffer): number | null {
  if (handle.length === 8) {
    const value = handle.readBigUInt64LE(0)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (handle.length === 4) return handle.readUInt32LE(0)
  return null
}
