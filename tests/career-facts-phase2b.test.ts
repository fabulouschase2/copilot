/**
 * Phase 2 completion — résumé import and fact verification.
 *
 * The load-bearing guarantee: a model-proposed fact is stored only when its
 * supporting quote exists verbatim in the document. Everything else is
 * rejected and counted, so an invented employer or metric cannot become
 * "verified experience".
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractDocx,
  isDocxFile,
  readZipDirectory,
  wordXmlToText
} from '../src/main/services/context/docx-extract'
import {
  MAX_FACTS_PER_DOCUMENT,
  ResumeExtractionService,
  buildResumeFactPrompt,
  parseExtractedFacts
} from '../src/main/services/career/resume-facts'
import { SQLiteStore, SCHEMA_VERSION } from '../src/main/services/context/sqlite-store'
import { ContextService } from '../src/main/services/context/context-service'
import { ContextEngine } from '../src/main/services/context-engine'
import type { AIProvider } from '../src/main/services/providers/types'
import { ProviderError } from '../src/main/services/providers/types'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

/* ── minimal ZIP writer (test fixture only) ───────────────────────────── */

function makeZip(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data
    const method = entry.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14) // crc (not validated by the reader)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16) // crc
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(0, 42)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Jordan Avery — Senior Engineer</w:t></w:r></w:p>
    <w:p><w:r><w:t>Led a team of four engineers on a payments platform.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Reduced CI build times by 40% &amp; cut flaky tests by half.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Skills:</w:t></w:r><w:r><w:tab/><w:t>TypeScript, SQLite, Electron</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>2019-2024</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Acme Corp</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`

describe('DOCX extraction', () => {
  it('reads a stored (uncompressed) document.xml', () => {
    const zip = makeZip([{ name: 'word/document.xml', data: Buffer.from(DOC_XML, 'utf8'), deflate: false }])
    const result = extractDocx('resume.docx', new Uint8Array(zip))
    expect(result.status).toBe('ready')
    expect(result.text).toContain('Jordan Avery')
    expect(result.text).toContain('Led a team of four engineers')
    expect(result.text).toContain('40% & cut flaky tests')
    expect(result.text).toContain('TypeScript')
  })

  it('reads a deflated document.xml (the normal case)', () => {
    const zip = makeZip([{ name: 'word/document.xml', data: Buffer.from(DOC_XML, 'utf8'), deflate: true }])
    const result = extractDocx('resume.docx', new Uint8Array(zip))
    expect(result.status).toBe('ready')
    expect(result.text).toContain('Acme Corp')
  })

  it('keeps paragraph and table structure as line/tab breaks', () => {
    const text = wordXmlToText(DOC_XML)
    expect(text.split('\n').length).toBeGreaterThan(3)
    expect(text).toContain('Skills:')
  })

  it('rejects a .doc renamed to .docx with a useful message', () => {
    const result = extractDocx('resume.docx', new Uint8Array(Buffer.from('not a zip at all')))
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/Not a valid \.docx archive/i)
  })

  it('rejects an archive without word/document.xml', () => {
    const zip = makeZip([{ name: 'word/styles.xml', data: Buffer.from('<x/>'), deflate: false }])
    const result = extractDocx('resume.docx', new Uint8Array(zip))
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/no word\/document\.xml/i)
  })

  it('rejects other extensions and empty files', () => {
    expect(extractDocx('resume.pdf', new Uint8Array([1, 2, 3])).status).toBe('failed')
    expect(extractDocx('resume.docx', new Uint8Array()).status).toBe('failed')
  })

  it('detects the docx magic bytes and lists entries', () => {
    const zip = makeZip([{ name: 'word/document.xml', data: Buffer.from(DOC_XML), deflate: true }])
    expect(isDocxFile('a.docx', new Uint8Array(zip))).toBe(true)
    expect(isDocxFile('a.pdf', new Uint8Array(zip))).toBe(false)
    expect(readZipDirectory(new Uint8Array(zip))[0].name).toBe('word/document.xml')
  })
})

describe('quote-anchored fact parsing', () => {
  const documentText =
    'Led a team of four engineers on a payments platform. Reduced CI build times by 40% and cut flaky tests by half. Skills: TypeScript, SQLite, Electron.'

  it('accepts facts whose quote appears verbatim (whitespace/case tolerant)', () => {
    const raw = JSON.stringify([
      {
        text: 'Led a team of four engineers',
        category: 'background',
        sourceText: 'led a team of four engineers on a payments platform'
      }
    ])
    const parsed = parseExtractedFacts(raw, documentText)
    expect(parsed.facts).toHaveLength(1)
    expect(parsed.rejected).toHaveLength(0)
    expect(parsed.facts[0].sourceText).toContain('four engineers')
  })

  it('rejects a quote that is not in the document (fabrication gate)', () => {
    const raw = JSON.stringify([
      {
        text: 'Led a team of twelve engineers',
        category: 'background',
        sourceText: 'Led a team of twelve engineers at Google'
      }
    ])
    const parsed = parseExtractedFacts(raw, documentText)
    expect(parsed.facts).toHaveLength(0)
    expect(parsed.rejected[0].reason).toMatch(/does not appear/i)
  })

  it('rejects missing quotes, bad categories and short text', () => {
    const raw = JSON.stringify([
      { text: 'Led a team of four engineers', category: 'background', sourceText: '' },
      { text: 'Reduced build times by 40%', category: 'superpower', sourceText: 'Reduced CI build times by 40%' },
      { text: 'short', category: 'skill', sourceText: 'TypeScript' }
    ])
    const parsed = parseExtractedFacts(raw, documentText)
    expect(parsed.facts).toHaveLength(0)
    expect(parsed.rejected).toHaveLength(3)
  })

  it('deduplicates and caps the list', () => {
    const many = Array.from({ length: MAX_FACTS_PER_DOCUMENT + 5 }, (_, i) => ({
      text: `Fact number ${i} about the platform`,
      category: 'project',
      sourceText: 'on a payments platform'
    }))
    many.push({ ...many[0] })
    // Put the duplicate early so it is evaluated before the cap is reached.
    many.unshift({ ...many[0] })
    const parsed = parseExtractedFacts(JSON.stringify(many), documentText)
    expect(parsed.facts.length).toBeLessThanOrEqual(MAX_FACTS_PER_DOCUMENT)
    expect(parsed.facts.length).toBeGreaterThan(0)
    expect(parsed.rejected.some((r) => /Duplicate/i.test(r.reason))).toBe(true)
  })

  it('handles fenced JSON and rejects non-JSON', () => {
    const fenced = '```json\n[{"text":"Led a team of four engineers","category":"background","sourceText":"Led a team of four engineers"}]\n```'
    expect(parseExtractedFacts(fenced, documentText).facts).toHaveLength(1)
    expect(parseExtractedFacts('I cannot do that', documentText).rejected[0].reason).toMatch(/JSON array/i)
  })

  it('tells the model the rules', () => {
    const prompt = buildResumeFactPrompt('resume.docx', documentText)
    expect(prompt).toContain('verbatim')
    expect(prompt).toContain('Never infer')
    expect(prompt).toContain('untrusted data')
  })
})

/* ── extraction service ───────────────────────────────────────────────── */

function fakeProvider(output: string, error?: Error): AIProvider {
  return {
    id: 'fake',
    label: 'Fake Provider',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream() {
      if (error) throw error
      yield { type: 'delta' as const, text: output }
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 1 }
    }
  }
}

const DOC_TEXT =
  'Led a team of four engineers on a payments platform. Reduced CI build times by 40 percent. Skills: TypeScript, SQLite, Electron.'

function extractionHarness(output: string, error?: Error) {
  const inserted: Array<Record<string, unknown>> = []
  const service = new ResumeExtractionService({
    listDocuments: () => [{ sourceId: 'doc-1', displayName: 'resume.docx', text: DOC_TEXT }],
    addFact: (f) => inserted.push({ ...f }),
    resolveProvider: () => ({ provider: fakeProvider(output, error), model: 'm' }),
    getProfileId: () => 'default',
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    idFactory: () => `fact-${inserted.length + 1}`
  })
  return { service, inserted }
}

describe('ResumeExtractionService', () => {
  it('stores only verified facts, as pending, with provenance', async () => {
    const output = JSON.stringify([
      {
        text: 'Led a team of four engineers',
        category: 'background',
        sourceText: 'Led a team of four engineers on a payments platform'
      },
      {
        text: 'Led a team of twenty engineers',
        category: 'background',
        sourceText: 'Led a team of twenty engineers'
      }
    ])
    const { service, inserted } = extractionHarness(output)
    const res = await service.extractFromDocument('doc-1')
    expect(res.ok).toBe(true)
    expect(res.added).toBe(1)
    expect(res.rejected).toHaveLength(1)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]['status']).toBe('pending')
    expect(inserted[0]['origin']).toBe('model')
    expect(inserted[0]['sourceText']).toContain('four engineers')
    expect(inserted[0]['sourceDocumentId']).toBe('doc-1')
  })

  it('refuses when nothing could be verified', async () => {
    const output = JSON.stringify([
      { text: 'Managed a budget of two million', category: 'background', sourceText: 'Managed a budget of two million' }
    ])
    const { service, inserted } = extractionHarness(output)
    const res = await service.extractFromDocument('doc-1')
    expect(res.ok).toBe(false)
    expect(res.added).toBe(0)
    expect(inserted).toHaveLength(0)
    expect(res.message).toMatch(/No fact could be verified/i)
  })

  it('reports unknown documents and missing providers', async () => {
    const { service } = extractionHarness('[]')
    expect((await service.extractFromDocument('nope')).message).toMatch(/Unknown document/i)
  })

  it('surfaces provider errors verbatim', async () => {
    const { service } = extractionHarness('', new ProviderError('Rate limited by provider (429)', 429))
    const res = await service.extractFromDocument('doc-1')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('429')
  })
})

/* ── persistence and retrieval ────────────────────────────────────────── */

describe('schema v5 fact lifecycle', () => {
  it('round-trips status, source text and document link', () => {
    const dir = tempDir()
    const store = new SQLiteStore(path.join(dir, 'context.db'))
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5)
    store.addFact({
      factId: 'f1',
      text: 'Led a team of four engineers',
      category: 'background',
      origin: 'model',
      status: 'pending',
      sourceText: 'Led a team of four engineers on a payments platform',
      sourceDocumentId: 'doc-1',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      profileId: 'default'
    })
    const [fact] = store.listFacts('default')
    expect(fact.status).toBe('pending')
    expect(fact.sourceText).toContain('four engineers')
    expect(fact.sourceDocumentId).toBe('doc-1')

    expect(store.setFactStatus('f1', 'confirmed', '2026-02-02T00:00:00.000Z')).toBe(true)
    expect(store.listFacts('default')[0].status).toBe('confirmed')
    store.close()
  })

  it('upgrades a v4 database: adds columns, keeps facts, defaults them to confirmed', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'old.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE profile_facts (
        fact_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT 'default'
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '4');
      INSERT INTO profile_facts VALUES ('old-1', 'Seven years of Go', 'skill', 'user', '2026-01-01', '2026-01-01', 'default');
    `)
    db.close()

    const store = new SQLiteStore(dbPath)
    const facts = store.listFacts('default')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('Seven years of Go')
    expect(facts[0].status).toBe('confirmed')
    expect(facts[0].sourceText).toBeNull()
    store.close()
  })
})

describe('retrieval uses verified facts only', () => {
  function makeStore() {
    const facts = [
      {
        factId: 'confirmed-1',
        text: 'Reduced CI build times by 40 percent',
        category: 'project' as const,
        origin: 'user' as const,
        status: 'confirmed' as const,
        sourceText: null,
        sourceDocumentId: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        profileId: 'default'
      },
      {
        factId: 'pending-1',
        text: 'Reduced CI build times by 90 percent',
        category: 'project' as const,
        origin: 'model' as const,
        status: 'pending' as const,
        sourceText: 'invented',
        sourceDocumentId: 'doc-1',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        profileId: 'default'
      },
      {
        factId: 'rejected-1',
        text: 'Managed a team of fifty engineers',
        category: 'background' as const,
        origin: 'model' as const,
        status: 'rejected' as const,
        sourceText: 'invented',
        sourceDocumentId: 'doc-1',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        profileId: 'default'
      }
    ]
    return {
      listDocuments: () => [],
      listFacts: () => facts,
      isExcluded: () => false,
      setExcluded: () => undefined,
      addDocument: () => undefined,
      removeDocument: () => undefined,
      addFact: () => undefined,
      updateFact: () => true,
      removeFact: () => true,
      setFactStatus: () => true
    }
  }

  it('never returns pending or rejected facts to a prompt', () => {
    const service = new ContextService({
      store: makeStore(),
      engine: new ContextEngine(),
      settings: () => ({ totalTokenBudget: 1_200, perSourceCharBudget: 1_200, minScore: 0.01 })
    })
    const result = service.retrieve('build times engineers', {
      includeDocuments: true,
      includeProfile: true,
      includeSession: false
    })
    const ids = result.items.map((i) => i.sourceId)
    expect(ids).toContain('confirmed-1')
    expect(ids).not.toContain('pending-1')
    expect(ids).not.toContain('rejected-1')
  })

  it('exposes provenance through listFactDetails', () => {
    const service = new ContextService({
      store: makeStore(),
      engine: new ContextEngine(),
      settings: () => ({ totalTokenBudget: 1_200, perSourceCharBudget: 1_200, minScore: 0.01 })
    })
    const details = service.listFactDetails()
    expect(details).toHaveLength(3)
    expect(details.find((f) => f.factId === 'pending-1')?.status).toBe('pending')
    expect(details.find((f) => f.factId === 'confirmed-1')?.sourceText).toBeNull()
  })
})
