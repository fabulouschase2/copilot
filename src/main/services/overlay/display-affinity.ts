/**
 * Windows capture exclusion through `SetWindowDisplayAffinity`.
 *
 * Electron does not expose this API, so we bind user32 directly with koffi
 * (a prebuilt FFI, no compiler required). Everything is defensive: the app
 * must run normally when koffi is missing, when the OS is too old, or when
 * the call fails — in those cases the overlay stays visible and the UI says
 * so instead of claiming privacy it does not have.
 *
 * Verified on Windows 11 22000: SetWindowDisplayAffinity(HWND,
 * WDA_EXCLUDEFROMCAPTURE) returns 1 and GetWindowDisplayAffinity echoes
 * 0x11; setting WDA_NONE restores 0x0.
 */
import * as os from 'node:os'
import {
  AffinitySupport,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_NONE,
  assessSupport,
  explainWin32Error,
  readHwnd
} from './overlay-state'

type NativeFunc = (...args: unknown[]) => unknown

interface KoffiLibrary {
  func(signature: string): NativeFunc
}

interface KoffiModule {
  load(path: string): KoffiLibrary
  errno(): number
}

interface Bindings {
  set: NativeFunc
  get: NativeFunc
  errno: () => number
}

let koffiModule: KoffiModule | null | undefined
let bindings: Bindings | null | undefined

function loadKoffi(): KoffiModule | null {
  if (koffiModule !== undefined) return koffiModule
  try {
    // Deliberately lazy: a missing native binding must not break app start.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    koffiModule = require('koffi') as KoffiModule
  } catch {
    koffiModule = null
  }
  return koffiModule
}

function loadBindings(): Bindings | null {
  if (bindings !== undefined) return bindings
  const koffi = loadKoffi()
  if (!koffi) {
    bindings = null
    return null
  }
  try {
    const user32 = koffi.load('user32.dll')
    bindings = {
      set: user32.func('int __stdcall SetWindowDisplayAffinity(void *hwnd, uint32 dwAffinity)'),
      get: user32.func('int __stdcall GetWindowDisplayAffinity(void *hwnd, _Out_ uint32 *pdwAffinity)'),
      errno: () => koffi.errno()
    }
  } catch {
    bindings = null
  }
  return bindings
}

export interface AffinityOutcome {
  /** True only when the OS confirmed the requested affinity afterwards. */
  ok: boolean
  affinity: number | null
  message: string
  errorCode: number | null
}

export class WindowsCaptureExclusion {
  readonly support: AffinitySupport
  readonly supportMessage: string

  constructor(
    platform: string = process.platform,
    release: string = os.release()
  ) {
    const available = platform === 'win32' ? loadBindings() !== null : true
    const assessed = assessSupport(platform, release, available)
    this.support = assessed.support
    this.supportMessage = assessed.message
  }

  get supported(): boolean {
    return this.support === 'supported'
  }

  /** Read the current affinity, or null when it cannot be read. */
  read(hwndBuffer: Buffer): number | null {
    if (!this.supported) return null
    const api = loadBindings()
    const hwnd = readHwnd(hwndBuffer)
    if (!api || hwnd === null) return null
    try {
      const out = [0]
      const ok = api.get(hwnd, out)
      return ok === 0 ? null : out[0]
    } catch {
      return null
    }
  }

  /**
   * Apply or clear capture exclusion. Success means the OS echoed the exact
   * flag back — not merely that the call returned.
   */
  apply(hwndBuffer: Buffer, excluded: boolean): AffinityOutcome {
    if (!this.supported) {
      return { ok: false, affinity: null, message: this.supportMessage, errorCode: null }
    }
    const api = loadBindings()
    const hwnd = readHwnd(hwndBuffer)
    if (!api || hwnd === null) {
      return { ok: false, affinity: null, message: 'The window handle could not be read.', errorCode: null }
    }
    const target = excluded ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE
    let callOk: unknown = 0
    try {
      callOk = api.set(hwnd, target)
    } catch (err) {
      return {
        ok: false,
        affinity: null,
        message: err instanceof Error ? err.message : 'SetWindowDisplayAffinity threw.',
        errorCode: null
      }
    }
    const errorCode = callOk === 0 ? api.errno() : 0
    const observed = this.read(hwndBuffer)
    const ok = observed === target
    return {
      ok,
      affinity: observed,
      message: ok
        ? excluded
          ? 'Windows confirmed the overlay is excluded from capture.'
          : 'Windows confirmed the overlay is capturable again.'
        : `Windows did not apply the change. ${explainWin32Error(errorCode)}`,
      errorCode
    }
  }
}
