/**
 * Phase 6 — private overlay contract tests.
 *
 * The important property under test is honesty: a requested exclusion must
 * never be reported as active unless the OS-reported affinity says so.
 */
import { describe, expect, it } from 'vitest'
import {
  AppSettingsSchema,
  OverlayContentSchema,
  OverlaySetRequestSchema,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE
} from '../src/shared/protocol'
import {
  assessSupport,
  deriveOverlayState,
  describeAffinity,
  explainWin32Error,
  parseWindowsBuild,
  readHwnd
} from '../src/main/services/overlay/overlay-state'

const baseState = {
  enabled: true,
  visible: true,
  captureExcluded: true,
  affinity: WDA_EXCLUDEFROMCAPTURE as number | null,
  support: 'supported' as const,
  supportMessage: 'ok',
  opacity: 0.9,
  fontSize: 15,
  showCaptions: true,
  error: null,
  lastErrorCode: null
}

describe('Windows display-affinity support assessment', () => {
  it('parses the build out of an os.release() string', () => {
    expect(parseWindowsBuild('10.0.22000')).toBe(22000)
    expect(parseWindowsBuild('10.0.19041.1')).toBe(19041)
    expect(parseWindowsBuild('nonsense')).toBeNull()
    expect(parseWindowsBuild('')).toBeNull()
  })

  it('supports Windows 10 2004 (build 19041) and newer', () => {
    expect(assessSupport('win32', '10.0.19041', true).support).toBe('supported')
    expect(assessSupport('win32', '10.0.22000', true).support).toBe('supported')
  })

  it('reports an older build as unsupported rather than pretending', () => {
    const result = assessSupport('win32', '10.0.19040', true)
    expect(result.support).toBe('unsupported-os')
    expect(result.message).toContain('19040')
    expect(result.message).toContain('19041')
  })

  it('reports non-Windows platforms as unsupported', () => {
    expect(assessSupport('darwin', '23.1.0', true).support).toBe('unsupported-platform')
    expect(assessSupport('linux', '6.1.0', true).support).toBe('unsupported-platform')
  })

  it('reports a missing native binding distinctly from an unsupported OS', () => {
    const result = assessSupport('win32', '10.0.22000', false)
    expect(result.support).toBe('binding-unavailable')
    expect(result.message).toContain('koffi')
  })
})

describe('overlay state derivation (never over-claim)', () => {
  it('marks exclusion active only when the OS echoes WDA_EXCLUDEFROMCAPTURE', () => {
    const state = deriveOverlayState(baseState)
    expect(state.exclusionActive).toBe(true)
    expect(state.exclusionUnverified).toBe(false)
  })

  it('flags exclusion requested but not applied as unverified', () => {
    const state = deriveOverlayState({ ...baseState, affinity: WDA_NONE })
    expect(state.exclusionActive).toBe(false)
    expect(state.exclusionUnverified).toBe(true)
  })

  it('does not flag unverified when the user asked to stay capturable', () => {
    const state = deriveOverlayState({ ...baseState, captureExcluded: false, affinity: WDA_NONE })
    expect(state.exclusionActive).toBe(false)
    expect(state.exclusionUnverified).toBe(false)
  })

  it('treats an unreadable affinity as unverified, not active', () => {
    const state = deriveOverlayState({ ...baseState, affinity: null })
    expect(state.exclusionActive).toBe(false)
    expect(state.exclusionUnverified).toBe(true)
  })

  it('treats monitor-only affinity as not excluded from capture', () => {
    const state = deriveOverlayState({ ...baseState, affinity: WDA_MONITOR })
    expect(state.exclusionActive).toBe(false)
  })

  it('preserves display preferences for the renderer', () => {
    const state = deriveOverlayState({ ...baseState, opacity: 0.5, fontSize: 22, showCaptions: false })
    expect(state.opacity).toBe(0.5)
    expect(state.fontSize).toBe(22)
    expect(state.showCaptions).toBe(false)
  })
})

describe('diagnostic helpers', () => {
  it('names known affinities', () => {
    expect(describeAffinity(WDA_EXCLUDEFROMCAPTURE)).toContain('excluded')
    expect(describeAffinity(WDA_NONE)).toBe('capturable')
    expect(describeAffinity(WDA_MONITOR)).toContain('monitor')
    expect(describeAffinity(null)).toBe('unknown')
    expect(describeAffinity(0x99)).toContain('0x99')
  })

  it('explains Win32 failures without inventing causes', () => {
    expect(explainWin32Error(5)).toContain('Access denied')
    expect(explainWin32Error(87)).toContain('Invalid parameter')
    expect(explainWin32Error(1234)).toContain('1234')
    expect(explainWin32Error(null)).toContain('no error code')
  })

  it('reads HWND values from 4- and 8-byte handles', () => {
    const eight = Buffer.alloc(8)
    eight.writeBigUInt64LE(0x1234_5678n, 0)
    expect(readHwnd(eight)).toBe(0x1234_5678)
    const four = Buffer.alloc(4)
    four.writeUInt32LE(0x00ab_cdef, 0)
    expect(readHwnd(four)).toBe(0x00ab_cdef)
    expect(readHwnd(Buffer.alloc(3))).toBeNull()
  })
})

describe('overlay IPC schemas', () => {
  it('defaults the overlay off and capture-excluded on', () => {
    const settings = AppSettingsSchema.parse({})
    expect(settings.overlay).toEqual({
      enabled: false,
      captureExcluded: true,
      opacity: 0.94,
      fontSize: 15,
      showCaptions: true
    })
  })

  it('accepts partial patches', () => {
    expect(OverlaySetRequestSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(OverlaySetRequestSchema.parse({})).toEqual({})
  })

  it('rejects out-of-range display values', () => {
    expect(OverlaySetRequestSchema.safeParse({ opacity: 5 }).success).toBe(false)
    expect(OverlaySetRequestSchema.safeParse({ opacity: 0.1 }).success).toBe(false)
    expect(OverlaySetRequestSchema.safeParse({ fontSize: 100 }).success).toBe(false)
    expect(OverlaySetRequestSchema.safeParse({ fontSize: 12.5 }).success).toBe(false)
  })

  it('bounds overlay content so the window cannot be flooded', () => {
    expect(OverlayContentSchema.safeParse({ kind: 'answer', text: 'ok' }).success).toBe(true)
    expect(OverlayContentSchema.safeParse({ kind: 'answer', text: 'x'.repeat(20_001) }).success).toBe(false)
    expect(OverlayContentSchema.safeParse({ kind: 'nope', text: 'x' }).success).toBe(false)
    expect(
      OverlayContentSchema.safeParse({ kind: 'caption', text: 'hi', source: 'system' }).success
    ).toBe(true)
  })
})
