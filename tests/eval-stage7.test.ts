import { describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { ContextService } from '../src/main/services/context/context-service'
import { rank } from '../src/main/services/context/ranking'

/**
 * Stage 7 evaluation + performance.
 *
 * The evaluation set is small, reproducible, and labeled by construction:
 * each query names the document that should rank first. Results are printed
 * and reported verbatim — no invented percentages. Retrieval quality beyond
 * this set is explicitly NOT claimed.
 */

const SETTINGS = { totalTokenBudget: 1_200, perSourceCharBudget: 1_200, minScore: 0.05 }

const DOCS: Array<[string, string]> = [
  ['resume.md', 'Experience: six years of TypeScript, three years of Rust, two years of Python. Led a team of four engineers building developer tools.'],
  ['runbook.md', 'Deployment policy: ship behind a feature flag, canary for ten minutes, then roll forward. Rollback via the release dashboard.'],
  ['architecture.md', 'The desktop app uses Electron with a TypeScript main process, a React renderer, and SQLite for local storage.'],
  ['interview-prep.md', 'Behavioral interviews use the STAR format: situation, task, action, result. Practice with metrics in every answer.'],
  ['project-phoenix.md', 'Project Phoenix: migrating the billing service from Python to Rust. Deadline is end of quarter. Team: two engineers.'],
  ['meeting-notes.md', 'Q3 planning: the hiring plan was approved. Priority is the billing migration and the copilot launch.']
]

// Each query lists the displayName expected at rank 1 (and optionally rank 2).
const EVAL: Array<{ query: string; top1: string; top2?: string }> = [
  { query: 'what is our deployment and rollback policy?', top1: 'runbook.md' },
  { query: 'how much Rust experience do I have?', top1: 'resume.md' },
  { query: 'what storage does the desktop app use?', top1: 'architecture.md' },
  { query: 'STAR format behavioral interview answers', top1: 'interview-prep.md' },
  { query: 'phoenix migration deadline and team', top1: 'project-phoenix.md', top2: 'meeting-notes.md' },
  { query: 'hiring plan priority for Q3', top1: 'meeting-notes.md', top2: 'project-phoenix.md' }
]

describe('Stage 7 ranking evaluation (reproducible, labeled)', () => {
  it('evaluates top-1 / top-2 hit rates on the labeled set', () => {
    const items = DOCS.map(([displayName, text], i) => ({
      itemId: `e${i}`,
      sourceId: `doc-${i}`,
      type: 'document' as const,
      displayName,
      text,
      updatedAt: 1_700_000_000_000
    }))
    let top1Hits = 0
    let top2Hits = 0
    const misses: string[] = []
    for (const c of EVAL) {
      const out = rank(c.query, items, { minScore: 0.05, recencyWindowMs: 0 })
      const names = out.map((r) => r.displayName)
      if (names[0] === c.top1) top1Hits += 1
      else misses.push(`"${c.query}" → got ${names[0] ?? 'none'}, wanted ${c.top1}`)
      if (c.top2 && names[1] === c.top2) top2Hits += 1
      // eslint-disable-next-line no-console
      console.log(`[eval] ${c.query} → ${names.slice(0, 2).join(' | ')}`)
    }
    // eslint-disable-next-line no-console
    console.log(
      `[eval] top-1: ${top1Hits}/${EVAL.length}, top-2 (where labeled): ${top2Hits}/${EVAL.filter((e) => e.top2).length}` +
        (misses.length ? `; misses: ${misses.join(' ; ')}` : '')
    )
    // Honest gate: the set was designed so this deterministic ranker solves
    // it; a regression here signals a ranking bug, not general quality.
    expect(top1Hits).toBe(EVAL.length)
  })
})

describe('Stage 7 performance (measured, printed)', () => {
  it('retrieval over 60 synthetic documents stays far below an interactive budget', { timeout: 60_000 }, async () => {
    const store = new ContextStoreProxy()
    const engine = new ContextEngine()
    const service = new ContextService({ store, engine, settings: () => SETTINGS })
    for (let i = 0; i < 60; i++) {
      // ~2 KB each → ~120 KB corpus
      const body = `document ${i} discusses topic ${i % 10} with sufficient vocabulary to rank meaningfully. `.repeat(24)
      store.inject(`doc-${i}`, `doc${i}.md`, body)
    }
    const rssBefore = process.memoryUsage().rss
    const times: number[] = []
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      const out = service.retrieve(`topic ${i % 10} vocabulary details`, {
        includeDocuments: true,
        includeProfile: false,
        includeSession: false
      })
      times.push(performance.now() - t0)
      expect(out.items.length).toBeGreaterThan(0)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const rssAfter = process.memoryUsage().rss
    // eslint-disable-next-line no-console
    console.log(
      `[perf] retrieval over 60 docs (~120 KB): avg ${avg.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms, ` +
        `RSS delta ${((rssAfter - rssBefore) / 1048576).toFixed(1)} MB`
    )
    expect(avg).toBeLessThan(50) // generous guard; measured value printed
  })
})

/** Minimal test double standing in for the file-backed store. */
class ContextStoreProxy {
  private docs: Array<{ sourceId: string; displayName: string; text: string; status: 'ready'; createdAt: string; updatedAt: string }> = []
  private excludedSourceIds: string[] = []
  private excludedTypes: string[] = []

  inject(sourceId: string, displayName: string, text: string): void {
    const now = new Date().toISOString()
    this.docs.push({ sourceId, displayName, text, status: 'ready', createdAt: now, updatedAt: now })
  }

  listDocuments() {
    return [...this.docs]
  }
  listFacts() {
    return []
  }
  isExcluded(sourceId: string, type: string): boolean {
    return this.excludedSourceIds.includes(sourceId) || this.excludedTypes.includes(type)
  }
  setExcluded(sourceId: string | undefined, type: string | undefined, excluded: boolean): void {
    if (sourceId) this.excludedSourceIds = excluded ? [sourceId] : []
    if (type) this.excludedTypes = excluded ? [type] : []
  }
  addDocument() {
    throw new Error('not used')
  }
  removeDocument() {
    throw new Error('not used')
  }
  addFact() {
    throw new Error('not used')
  }
  updateFact(): boolean {
    throw new Error('not used')
  }
  removeFact(): boolean {
    throw new Error('not used')
  }
  clearAll() {
    throw new Error('not used')
  }
  getDocument() {
    return undefined
  }
}
