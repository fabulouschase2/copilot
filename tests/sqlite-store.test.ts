import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SQLiteStore } from '../src/main/services/context/sqlite-store'

const dirs: string[] = []
const openStores: SQLiteStore[] = []
function makeStore(): { store: SQLiteStore; dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sqlite-'))
  dirs.push(dir)
  const dbPath = path.join(dir, 'context.db')
  const store = new SQLiteStore(dbPath)
  openStores.push(store)
  return { store, dir, dbPath }
}

const DOC = {
  sourceId: 'doc-1',
  displayName: 'resume.md',
  text: 'Six years of TypeScript.',
  status: 'ready' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const FACT = {
  factId: 'fact-1',
  text: 'Prefers concise answers',
  category: 'preference' as const,
  origin: 'user' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

afterEach(() => {
  // Windows: close all handles before deleting, or rmSync hits EPERM.
  for (const s of openStores.splice(0)) {
    try {
      s.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe('SQLiteStore — schema and CRUD', () => {
  it('creates schema version 1 on open', () => {
    const { store } = makeStore()
    expect(store.integrityCheck().ok).toBe(true)
    expect(store.counts()).toEqual({ documents: 0, facts: 0 })
    store.close()
  })

  it('documents: add, list, get, remove (with dependent exclusion cleanup)', () => {
    const { store } = makeStore()
    store.addDocument(DOC)
    store.setExcluded('doc-1', undefined, true)
    expect(store.listDocuments()).toHaveLength(1)
    expect(store.getDocument('doc-1')?.displayName).toBe('resume.md')

    store.removeDocument('doc-1')
    expect(store.listDocuments()).toHaveLength(0)
    // the exclusion row for the removed source is gone too
    expect(store.isExcluded('doc-1', 'document')).toBe(false)
  })

  it('profile facts: add/update/remove with boolean results', () => {
    const { store } = makeStore()
    store.addFact(FACT)
    expect(store.listFacts()).toHaveLength(1)
    expect(store.updateFact('fact-1', { text: 'Prefers very short answers' })).toBe(true)
    expect(store.listFacts()[0].text).toContain('very short')
    expect(store.updateFact('nope', { text: 'x' })).toBe(false)
    expect(store.removeFact('fact-1')).toBe(true)
    expect(store.removeFact('fact-1')).toBe(false)
  })

  it('exclusions work per source and per category independently', () => {
    const { store } = makeStore()
    store.setExcluded(undefined, 'document', true)
    expect(store.isExcluded('doc-1', 'document')).toBe(true)
    expect(store.isExcluded('fact-1', 'profile')).toBe(false)
    store.setExcluded(undefined, 'document', false)
    expect(store.isExcluded('doc-1', 'document')).toBe(false)
  })

  it('rejects invalid status and category values (CHECK constraints)', () => {
    const { store } = makeStore()
    expect(() => store.addDocument({ ...DOC, status: 'bogus' as 'ready' })).toThrow()
    expect(() => store.addFact({ ...FACT, category: 'vibes' as 'skill' })).toThrow()
    // nothing was written
    expect(store.counts()).toEqual({ documents: 0, facts: 0 })
  })

  it('data persists across close/reopen (application restart path)', () => {
    const { store, dbPath } = makeStore()
    store.addDocument(DOC)
    store.addFact(FACT)
    store.setExcluded(undefined, 'screen', true)
    store.close()

    const reopened = new SQLiteStore(dbPath)
    expect(reopened.listDocuments()).toHaveLength(1)
    expect(reopened.listFacts()).toHaveLength(1)
    expect(reopened.isExcluded('any', 'screen')).toBe(true)
    expect(reopened.integrityCheck().ok).toBe(true)
    reopened.close()
  })

  it('clearAll removes everything', () => {
    const { store } = makeStore()
    store.addDocument(DOC)
    store.addFact(FACT)
    store.setExcluded(undefined, 'screen', true)
    store.clearAll()
    expect(store.counts()).toEqual({ documents: 0, facts: 0 })
    expect(store.isExcluded('x', 'screen')).toBe(false)
  })
})

describe('SQLiteStore — backup and restore', () => {
  it('backup writes a valid, restorable copy; restore never touches the only copy', () => {
    const { store, dir } = makeStore()
    store.addDocument(DOC)
    const backupPath = path.join(dir, 'backups', 'context-backup-test.db')
    store.backup(backupPath)
    expect(existsSync(backupPath)).toBe(true)

    // Mutate the live store after backup.
    store.addDocument({ ...DOC, sourceId: 'doc-2', displayName: 'later.md' })
    expect(store.listDocuments()).toHaveLength(2)

    // Restore = open the backup as a fresh store and verify contents.
    const restored = new SQLiteStore(backupPath)
    expect(restored.listDocuments()).toHaveLength(1)
    expect(restored.getDocument('doc-1')).not.toBeUndefined()
    expect(restored.listDocuments()[0].displayName).toBe('resume.md')
    restored.close()
  })

  it('backup into a nonexistent nested directory works', () => {
    const { store, dir } = makeStore()
    const deep = path.join(dir, 'a', 'b', 'backup.db')
    store.backup(deep)
    expect(existsSync(deep)).toBe(true)
  })
})
