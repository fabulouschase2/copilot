/**
 * Live context engine (Module C, first increment).
 *
 * Holds bounded, deduplicated context items (transcript segments, screen text,
 * profile facts, notes) and assembles a rolling window for prompts. Pinned
 * items survive eviction and are always included; everything else is selected
 * newest-first within a token budget and returned in chronological order so
 * prompts read naturally.
 */

export type ContextKind = 'transcript' | 'screen' | 'profile' | 'doc' | 'note'

export interface ContextItem {
  id: string
  kind: ContextKind
  text: string
  timestamp: number
  pinned?: boolean
  /** Stage 7: session scope. Session-scoped items are wiped when a new
   * session begins and are only retrievable by their own session. */
  sessionId?: string
}

/** Rough token estimate; good enough for budgeting, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface ContextEngineOptions {
  maxItems?: number
  maxAgeMs?: number
}

export class ContextEngine {
  private items: ContextItem[] = []
  private readonly maxItems: number
  private readonly maxAgeMs: number

  constructor(opts: ContextEngineOptions = {}) {
    this.maxItems = opts.maxItems ?? 200
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60_000
  }

  /**
   * Add an item. A duplicate (same normalized text, any kind) refreshes the
   * existing item's timestamp and moves it to the end instead of adding a copy.
   */
  add(item: ContextItem): void {
    const key = normalize(item.text)
    const existingIdx = this.items.findIndex((i) => normalize(i.text) === key)
    if (existingIdx !== -1) {
      const existing = this.items[existingIdx]
      this.items.splice(existingIdx, 1)
      this.items.push({ ...existing, timestamp: item.timestamp })
      return
    }
    this.items.push({ ...item, text: item.text.trim() })
    this.evict()
  }

  private evict(): void {
    const cutoff = Date.now() - this.maxAgeMs
    this.items = this.items.filter((i) => i.pinned || i.timestamp >= cutoff)
    while (this.items.length > this.maxItems) {
      const idx = this.items.findIndex((i) => !i.pinned)
      if (idx === -1) break
      this.items.splice(idx, 1)
    }
  }

  clear(): void {
    this.items = []
  }

  /** Remove every session-scoped item (transcript/screen). */
  clearSessionScoped(): void {
    this.items = this.items.filter((i) => i.sessionId === undefined)
  }

  /** Session-scoped items for one session id. */
  itemsForSession(sessionId: string): ContextItem[] {
    return this.items.filter((i) => i.sessionId === sessionId)
  }

  remove(itemId: string): void {
    this.items = this.items.filter((i) => i.id !== itemId)
  }

  snapshot(): readonly ContextItem[] {
    return [...this.items]
  }

  /**
   * Assemble the rolling window: pinned items first, then newest items until
   * the token budget is exhausted. Returned in chronological order.
   */
  build(maxTokens = 2000): ContextItem[] {
    const pinned = this.items.filter((i) => i.pinned)
    const rest = this.items.filter((i) => !i.pinned).slice().reverse()
    const chosen: ContextItem[] = []
    let budget = maxTokens - pinned.reduce((sum, i) => sum + estimateTokens(i.text), 0)
    for (const item of rest) {
      const cost = estimateTokens(item.text)
      if (budget - cost < 0) break
      budget -= cost
      chosen.push(item)
    }
    return [...pinned, ...chosen].sort((a, b) => a.timestamp - b.timestamp)
  }

  /** Render selected items as a labeled system-context block. */
  render(maxTokens = 2000): string {
    const items = this.build(maxTokens)
    if (items.length === 0) return ''
    const lines = items.map((i) => `[${i.kind}] ${i.text}`)
    return lines.join('\n')
  }
}
