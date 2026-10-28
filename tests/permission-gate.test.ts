import { describe, expect, it } from 'vitest'
import { PermissionGate } from '../src/main/services/audio/permission-gate'

describe('PermissionGate', () => {
  it('grants exactly one approval per arm', () => {
    const gate = new PermissionGate()
    expect(gate.consume('media')).toBe(false) // nothing armed
    gate.arm('media')
    expect(gate.isArmed('media')).toBe(true)
    expect(gate.consume('media')).toBe(true)
    expect(gate.consume('media')).toBe(false) // one-shot
  })

  it('permissions are independent per kind', () => {
    const gate = new PermissionGate()
    gate.arm('media')
    expect(gate.consume('display-capture')).toBe(false)
    expect(gate.consume('media')).toBe(true)
  })

  it('expires after the TTL', () => {
    let now = 1_000_000
    const gate = new PermissionGate(30_000, () => now)
    gate.arm('media')
    now += 29_999
    expect(gate.consume('media')).toBe(true)
  })

  it('rejects an expired approval instead of granting it', () => {
    let now = 1_000_000
    const gate = new PermissionGate(30_000, () => now)
    gate.arm('display-capture')
    now += 30_001
    expect(gate.isArmed('display-capture')).toBe(false)
    expect(gate.consume('display-capture')).toBe(false)
  })

  it('re-arm replaces the previous approval', () => {
    let now = 1_000_000
    const gate = new PermissionGate(30_000, () => now)
    gate.arm('media')
    now += 20_000
    gate.arm('media') // fresh TTL
    now += 20_000 // first arm would now be expired (40s), second is 20s old
    expect(gate.consume('media')).toBe(true)
  })

  it('revokeAll clears everything', () => {
    const gate = new PermissionGate()
    gate.arm('media')
    gate.arm('display-capture')
    gate.revokeAll()
    expect(gate.consume('media')).toBe(false)
    expect(gate.consume('display-capture')).toBe(false)
  })
})
