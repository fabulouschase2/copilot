import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { ContextService } from '../src/main/services/context/context-service'
import { ContextStore } from '../src/main/services/context/context-store'
import { SQLiteStore } from '../src/main/services/context/sqlite-store'
import { migrateLegacyJson } from '../src/main/services/context/migration'
import { ContextSettings } from '../src/shared/protocol'

const SETTINGS: ContextSettings = { totalTokenBudget: 1_200, perSourceCharBudget: 1_200, minScore: 0.05 }

const dirs: string[] = []
const openStores: SQLiteStore[] = []
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'equiv-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const s of openStores.splice(0)) {
    try {
      s.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const FIXTURES: Array<{ sourceId: string; displayName: string; text: string }> = [
  { sourceId: 'doc-1', displayName: 'runbook.md', text: 'Deployment policy: canary for ten minutes, then roll forward. Rollback via the dashboard.' },
  { sourceId: 'doc-2', displayName: 'resume.md', text: 'Six years of TypeScript, three years of Rust, team lead for four engineers.' },
  { sourceId: 'doc-3', displayName: 'stack.md', text: 'The stack is Electron, TypeScript main process, React renderer, SQLite storage.' }
]

describe('Stage 9 — retrieval equivalence: JSON store vs SQLite store', () => {
  it('produces identical ranked output for the same fixtures (same sourceIds)', async () => {
    const dir = makeDir()

    // JSON path (pre-Stage-9 behavior)
    const jsonStore = new ContextStore(path.join(dir, 'context-store.json'))
    const jsonService = new ContextService({ store: jsonStore, engine: new ContextEngine(), settings: () => SETTINGS })
    for (const f of FIXTURES) {
      const now = '2026-01-01T00:00:00.000Z'
      jsonStore.addDocument({ ...f, status: 'ready', createdAt: now, updatedAt: now })
    }

    // SQLite path (Stage 9), fed through the actual migration for realism
    const sqlite = new SQLiteStore(path.join(dir, 'context.db'))
    openStores.push(sqlite)
    const legacy = path.join(dir, 'legacy.json')
    const { writeFileSync } = await import('node:fs')
    const now = '2026-01-01T00:00:00.000Z'
    writeFileSync(
      legacy,
      JSON.stringify({ version: 1, documents: FIXTURES.map((f) => ({ ...f, status: 'ready', createdAt: now, updatedAt: now })), profileFacts: [] }),
      'utf-8'
    )
    const migrated = migrateLegacyJson(sqlite, legacy)
    expect(migrated.status).toBe('migrated')
    const sqliteService = new ContextService({ store: sqlite, engine: new ContextEngine(), settings: () => SETTINGS })

    const queries = [
      'what is the deployment and rollback policy?',
      'how much Rust experience do I have?',
      'which storage does the app use?'
    ]
    for (const q of queries) {
      const a = jsonService.retrieve(q, { includeDocuments: true, includeProfile: false, includeSession: false })
      const b = sqliteService.retrieve(q, { includeDocuments: true, includeProfile: false, includeSession: false })
      expect(b.items.map((i) => [i.sourceId, i.score])).toEqual(a.items.map((i) => [i.sourceId, i.score]))
      expect(b.estimatedTokens).toBe(a.estimatedTokens)
    }
  })

  it('exclusions and session isolation behave identically on SQLite', async () => {
    const dir = makeDir()
    const sqlite = new SQLiteStore(path.join(dir, 'context.db'))
    openStores.push(sqlite)
    const engine = new ContextEngine()
    const service = new ContextService({ store: sqlite, engine, settings: () => SETTINGS })

    const now = '2026-01-01T00:00:00.000Z'
    sqlite.addDocument({ ...FIXTURES[0], status: 'ready', createdAt: now, updatedAt: now })
    service.beginSession('sess-1')
    engine.add({ id: 't1', kind: 'transcript', text: 'we picked SQLite for storage', timestamp: Date.now(), sessionId: 'sess-1' })

    expect(service.retrieve('sqlite storage decision', { includeDocuments: false, includeProfile: false, includeSession: true }).items.length).toBe(1)
    service.endSession()
    expect(service.retrieve('sqlite storage decision', { includeDocuments: false, includeProfile: false, includeSession: true }).items).toHaveLength(0)

    // exclusion on SQLite blocks retrieval
    service.setExclusion('doc-1', undefined, true)
    expect(service.retrieve('deployment rollback policy', { includeDocuments: true, includeProfile: false, includeSession: false }).items).toHaveLength(0)
  })
})

describe('Stage 9 performance (measured, printed)', () => {
  it('open + bulk import + retrieval + backup on a 60-document corpus', () => {
    const dir = makeDir()
    const t0 = performance.now()
    const store = new SQLiteStore(path.join(dir, 'context.db'))
    const openMs = performance.now() - t0

    const t1 = performance.now()
    const now = '2026-01-01T00:00:00.000Z'
    store.transaction(() => {
      for (let i = 0; i < 60; i++) {
        store.addDocument({
          sourceId: `doc-${i}`,
          displayName: `doc${i}.md`,
          text: `document ${i} discusses topic ${i % 10} with enough vocabulary to rank. `.repeat(30),
          status: 'ready',
          createdAt: now,
          updatedAt: now
        })
      }
    })
    const importMs = performance.now() - t1

    const service = new ContextService({ store, engine: new ContextEngine(), settings: () => SETTINGS })
    const t2 = performance.now()
    for (let i = 0; i < 25; i++) {
      service.retrieve(`topic ${i % 10} vocabulary`, { includeDocuments: true, includeProfile: false, includeSession: false })
    }
    const retrievalAvg = (performance.now() - t2) / 25

    const t3 = performance.now()
    const backupPath = path.join(dir, 'backup.db')
    store.backup(backupPath)
    const backupMs = performance.now() - t3

    // eslint-disable-next-line no-console
    console.log(
      `[perf] sqlite: open ${openMs.toFixed(1)} ms, 60-doc import ${importMs.toFixed(1)} ms, ` +
        `retrieval avg ${retrievalAvg.toFixed(2)} ms, backup ${backupMs.toFixed(1)} ms`
    )
    expect(openMs).toBeLessThan(2_000)
    expect(importMs).toBeLessThan(2_000)
    expect(retrievalAvg).toBeLessThan(50)
    expect(backupMs).toBeLessThan(2_000)
    store.close()
  })
})
