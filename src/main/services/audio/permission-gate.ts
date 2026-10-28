/**
 * One-shot OS permission approvals (Module J).
 *
 * The renderer can never grant itself microphone or screen capture: it asks
 * main to ARM an approval when the user presses Start, and the Electron
 * permission handlers consult this gate. Approvals are consumed on first use
 * and expire, so a compromised renderer cannot re-arm capture silently.
 */
export type CapturePermission = 'media' | 'display-capture' | 'screen'

interface PendingApproval {
  expiresAt: number
}

export class PermissionGate {
  private pending = new Map<CapturePermission, PendingApproval>()
  private readonly ttlMs: number

  constructor(ttlMs = 30_000, private now: () => number = Date.now) {
    this.ttlMs = ttlMs
  }

  /** Arm one approval for `permission`; a previous one is replaced. */
  arm(permission: CapturePermission): void {
    this.pending.set(permission, { expiresAt: this.now() + this.ttlMs })
  }

  /** Consume a pending approval. Returns true exactly once per arm. */
  consume(permission: CapturePermission): boolean {
    const entry = this.pending.get(permission)
    if (!entry) return false
    this.pending.delete(permission)
    return this.now() <= entry.expiresAt
  }

  /** True when an unexpired approval is armed (used for UI hints). */
  isArmed(permission: CapturePermission): boolean {
    const entry = this.pending.get(permission)
    return entry !== undefined && this.now() <= entry.expiresAt
  }

  revokeAll(): void {
    this.pending.clear()
  }
}
