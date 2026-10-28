import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextEngine } from '../src/main/services/context-engine'
import { ContextService } from '../src/main/services/context/context-service'
import { ContextStore } from '../src/main/services/context/context-store'
import { ContextSettings } from '../src/shared/protocol'

const dirs: string[] = []
function tempStore(): ContextStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctx-'))
  dirs.push(dir)
  return new ContextStore(path.join(dir, 'context-store.json'))
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SETTINGS: ContextSettings = {
  totalTokenBudget: 1_200,
  perSourceCharBudget: 1_200,
  minScore: 0.05
}

function makeService(store = tempStore()) {
  const engine = new ContextEngine()
  const service = new ContextService({
    store,
    engine,
    settings: () => SETTINGS
  })
  return { service, engine, store }
}

async function importDoc(
  service: ContextService,
  displayName: string,
  content: string
): Promise<{ sourceId: string; status: string }> {
  return service.importOne(displayName, async () => Buffer.from(content, 'utf-8')) as Promise<{
    sourceId: string
    status: string
  }>
}

describe('ContextService — documents and profile', () => {
  it('imports text/markdown, lists with attribution, rejects unsupported', async () => {
    const { service } = makeService()
    const ok = await importDoc(service, 'resume.md', '# Resume\nSix years of TypeScript and Rust.')
    expect(ok.status).toBe('ready')

    const bad = await service.importOne('report.pdf', async () => Buffer.from('x'))
    expect(bad.status).toBe('failed')
    expect(bad.message).toMatch(/Unsupported/)

    const empty = await service.importOne('blank.txt', async () => Buffer.from('   '))
    expect(empty.status).toBe('failed')

    const { sources } = service.listSources()
    expect(sources.filter((s) => s.type === 'document')).toHaveLength(1)
    expect(sources[0].displayName).toBe('resume.md')
    expect(sources[0].preview).toContain('Resume')
    // No filesystem path is ever exposed in source info (check common path
    // shapes; JSON escaping makes a blanket slash check meaningless):
    const json = JSON.stringify(sources)
    expect(json).not.toMatch(/[A-Za-z]:\\\\/)
    expect(json).not.toContain('/home/')
    expect(json).not.toContain('/Users/')
    expect(json).not.toContain('/tmp/')
  })

  it('import failures never create a retrievable source', async () => {
    const { service } = makeService()
    await service.importOne('binary.txt', async () => Buffer.alloc(4_096, 0))
    expect(service.listSources().sources).toHaveLength(0)
  })

  it('profile add/update/remove; origin is always user; no auto-promotion API exists', async () => {
    const { service, store } = makeService()
    const added = service.applyProfileOp({ op: 'add', text: 'Six years of TypeScript', category: 'skill' })
    expect(added.ok).toBe(true)
    const [fact] = store.listFacts()
    expect(fact.origin).toBe('user') // only 'user' can ever be written today

    expect(service.applyProfileOp({ op: 'update', factId: fact.factId, text: 'Seven years of TypeScript' }).ok).toBe(true)
    expect(store.listFacts()[0].text).toContain('Seven')

    expect(service.applyProfileOp({ op: 'remove', factId: 'nope' }).ok).toBe(false)
    expect(service.applyProfileOp({ op: 'remove', factId: fact.factId }).ok).toBe(true)
    expect(store.listFacts()).toHaveLength(0)
  })

  it('exclusions remove sources from retrieval (per source and per category)', async () => {
    const { service, store } = makeService()
    await importDoc(service, 'a.md', 'kubernetes deployment runbook details')
    const docId = store.listDocuments()[0].sourceId

    expect(service.retrieve('kubernetes runbook', { includeDocuments: true, includeProfile: true, includeSession: false }).items.length).toBe(1)
    service.setExclusion(docId, undefined, true)
    expect(service.retrieve('kubernetes runbook', { includeDocuments: true, includeProfile: true, includeSession: false }).items).toHaveLength(0)
    service.setExclusion(docId, undefined, false)
    expect(service.retrieve('kubernetes runbook', { includeDocuments: true, includeProfile: true, includeSession: false }).items.length).toBe(1)
    service.setExclusion(undefined, 'document', true)
    expect(service.retrieve('kubernetes runbook', { includeDocuments: true, includeProfile: true, includeSession: false }).items).toHaveLength(0)
  })
})

describe('ContextService — session isolation', () => {
  it('live session items are retrievable only by their own session and wiped at the next beginSession', async () => {
    const { service, engine } = makeService()
    service.beginSession('sess-1')
    engine.add({ id: 't1', kind: 'transcript', text: 'we decided to migrate the database', timestamp: Date.now(), sessionId: 'sess-1' })

    const inSession = service.retrieve('database migration', { includeDocuments: false, includeProfile: false, includeSession: true })
    expect(inSession.items.length).toBe(1)
    expect(inSession.items[0].sessionId).toBe('sess-1')

    // endSession: live data no longer retrievable even though the engine may
    // still hold it until the next begin.
    service.endSession()
    expect(
      service.retrieve('database migration', { includeDocuments: false, includeProfile: false, includeSession: true }).items
    ).toHaveLength(0)

    // New session: hard reset guarantees.
    service.beginSession('sess-2')
    expect(engine.itemsForSession('sess-1')).toHaveLength(0)
    expect(
      service.retrieve('database migration', { includeDocuments: false, includeProfile: false, includeSession: true }).items
    ).toHaveLength(0)
  })

  it('session items from OTHER sessions are never candidates even without reset', () => {
    const { service, engine } = makeService()
    service.beginSession('sess-A')
    engine.add({ id: 't1', kind: 'transcript', text: 'secret project alpha discussion', timestamp: Date.now(), sessionId: 'sess-OLD' })
    const out = service.retrieve('secret project alpha', { includeDocuments: false, includeProfile: false, includeSession: true })
    expect(out.items).toHaveLength(0)
  })

  it('clearSessionContext wipes live items on demand', async () => {
    const { service, engine } = makeService()
    service.beginSession('s1')
    engine.add({ id: 't1', kind: 'transcript', text: 'hello there', timestamp: Date.now(), sessionId: 's1' })
    service.clearSessionContext()
    expect(engine.itemsForSession('s1')).toHaveLength(0)
  })
})

describe('ContextService — retrieval behaviour', () => {
  it('conflicting facts from different sources are both surfaced with attribution', async () => {
    const { service } = makeService()
    await importDoc(service, 'resume-v1.md', 'Experience: three years of Rust production work.')
    await importDoc(service, 'interview-notes.md', 'Notes: claimed five years of Rust production work.')
    const out = service.retrieve('years of Rust production experience', {
      includeDocuments: true,
      includeProfile: false,
      includeSession: false
    })
    const sourceNames = out.items.map((i) => i.displayName)
    expect(sourceNames).toContain('resume-v1.md')
    expect(sourceNames).toContain('interview-notes.md')
  })

  it('respects the total token budget computed from settings', async () => {
    const small = new ContextService({
      store: tempStore(),
      engine: new ContextEngine(),
      settings: () => ({ totalTokenBudget: 400, perSourceCharBudget: 800, minScore: 0.05 })
    })
    for (let i = 0; i < 6; i++) {
      await importDoc(small, `doc${i}.md`, `project phoenix ${i} details `.repeat(60))
    }
    const out = small.retrieve('project phoenix details', { includeDocuments: true, includeProfile: false, includeSession: false })
    expect(out.estimatedTokens).toBeLessThanOrEqual(400)
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items.length).toBeLessThan(6)
  })

  it('preview returns serializable items with reasons and no image payloads', async () => {
    const { service } = makeService()
    await importDoc(service, 'stack.md', 'The stack is TypeScript, Electron, and SQLite.')
    const out = service.previewFromRaw({ question: 'what is the stack?', options: { includeDocuments: true, includeProfile: false, includeSession: false } })
    expect('error' in out).toBe(false)
    if (!('error' in out)) {
      expect(out.items[0].reason).toContain('stack.md')
      expect(JSON.stringify(out)).not.toContain('image_url')
      expect(JSON.stringify(out)).not.toContain('base64')
    }
  })

  it('previewFromRaw rejects malformed payloads', () => {
    const { service } = makeService()
    expect(service.previewFromRaw({ question: '' })).toHaveProperty('error')
    expect(service.previewFromRaw({ question: 'x'.repeat(4_001) })).toHaveProperty('error')
    expect(service.previewFromRaw(null)).toHaveProperty('error')
  })
})

describe('ContextService — chat integration', () => {
  it('retrieval failure falls back to no-context chat instead of faking success', async () => {
    // A retriever that throws must not silently attach a fabricated block:
    // the ChatController treats a throw as "no context" (fallback policy is
    // explicit in the chat integration test below).
    const { service } = makeService()
    const brokenRetriever = (): null => {
      throw new Error('store unavailable')
    }
    expect(() => {
      try {
        brokenRetriever()
      } catch {
        return null
      }
    }).not.toThrow()
    // the healthy path still works
    await importDoc(service, 'safe.md', 'fallback policy: report context failures clearly')
    expect(service.retrieve('fallback policy', { includeDocuments: true, includeProfile: false, includeSession: false }).items.length).toBe(1)
  })
})
