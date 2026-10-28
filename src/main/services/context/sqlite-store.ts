/**
 * SQLite-backed persistence (Stage 9) — replaces the JSON knowledge store.
 *
 * Uses Node's built-in `node:sqlite` (verified inside Electron 38 / Node
 * 22.22): zero added dependencies, no native-module packaging risk.
 * Durability trade-off: WAL journal + synchronous=NORMAL (fast, safe against
 * crashes; a power cut may lose the last checkpoint, never corrupt).
 * Statements are prepared once and always parameterized. Secrets stay in the
 * OS credential store — never here. SQLite does NOT provide encryption at
 * rest; the file is plaintext under the user profile (documented).
 */
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ProfileCategory } from '../../../shared/protocol'

export const SCHEMA_VERSION = 2

export interface DocumentRecord {
  sourceId: string
  displayName: string
  text: string
  status: 'ready' | 'partial'
  createdAt: string
  updatedAt: string
}

export interface ProfileFactRecord {
  factId: string
  text: string
  category: ProfileCategory
  origin: 'user' | 'model'
  createdAt: string
  updatedAt: string
}

const CATEGORIES = new Set(['background', 'skill', 'preference', 'project', 'other'])

export interface MeetingRecord {
  meetingId: string
  title: string
  transcript: string
  notes: string
  createdAt: string
  updatedAt: string
}

export class SQLiteStore {
  private db: DatabaseSync
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
    this.prepare()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        source_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','partial')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_facts (
        fact_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('background','skill','preference','project','other')),
        origin TEXT NOT NULL CHECK(origin IN ('user','model')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exclusions (
        kind TEXT NOT NULL CHECK(kind IN ('source','type')),
        key TEXT NOT NULL,
        UNIQUE(kind, key)
      );
    `)
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const current = row ? Number((row as { value: string }).value) : 0
    if (current > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${current} is newer than this app supports (${SCHEMA_VERSION})`)
    }
    // v1 → v2: meetings table (user-approved saved meeting records).
    if (current < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meetings (
          meeting_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          transcript TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION))
    }
  }

  private stmts!: {
    insDoc: ReturnType<DatabaseSync['prepare']>
    allDocs: ReturnType<DatabaseSync['prepare']>
    getDoc: ReturnType<DatabaseSync['prepare']>
    delDoc: ReturnType<DatabaseSync['prepare']>
    delDocExcl: ReturnType<DatabaseSync['prepare']>
    insFact: ReturnType<DatabaseSync['prepare']>
    allFacts: ReturnType<DatabaseSync['prepare']>
    getFact: ReturnType<DatabaseSync['prepare']>
    updFact: ReturnType<DatabaseSync['prepare']>
    delFact: ReturnType<DatabaseSync['prepare']>
    exclExists: ReturnType<DatabaseSync['prepare']>
    exclIns: ReturnType<DatabaseSync['prepare']>
    exclDel: ReturnType<DatabaseSync['prepare']>
    clearDocs: ReturnType<DatabaseSync['prepare']>
    clearFacts: ReturnType<DatabaseSync['prepare']>
    clearExcl: ReturnType<DatabaseSync['prepare']>
    countDocs: ReturnType<DatabaseSync['prepare']>
    countFacts: ReturnType<DatabaseSync['prepare']>
  }

  private prepare(): void {
    const p = this.db.prepare.bind(this.db)
    this.stmts = {
      insDoc: p('INSERT OR REPLACE INTO documents (source_id, display_name, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      allDocs: p('SELECT source_id, display_name, text, status, created_at, updated_at FROM documents ORDER BY created_at'),
      getDoc: p('SELECT source_id, display_name, text, status, created_at, updated_at FROM documents WHERE source_id = ?'),
      delDoc: p('DELETE FROM documents WHERE source_id = ?'),
      delDocExcl: p("DELETE FROM exclusions WHERE kind = 'source' AND key = ?"),
      insFact: p('INSERT OR REPLACE INTO profile_facts (fact_id, text, category, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      allFacts: p('SELECT fact_id, text, category, origin, created_at, updated_at FROM profile_facts ORDER BY created_at'),
      getFact: p('SELECT fact_id FROM profile_facts WHERE fact_id = ?'),
      updFact: p('UPDATE profile_facts SET text = COALESCE(?, text), category = COALESCE(?, category), updated_at = ? WHERE fact_id = ?'),
      delFact: p('DELETE FROM profile_facts WHERE fact_id = ?'),
      exclExists: p('SELECT 1 AS one FROM exclusions WHERE kind = ? AND key = ?'),
      exclIns: p('INSERT OR IGNORE INTO exclusions (kind, key) VALUES (?, ?)'),
      exclDel: p('DELETE FROM exclusions WHERE kind = ? AND key = ?'),
      clearDocs: p('DELETE FROM documents'),
      clearFacts: p('DELETE FROM profile_facts'),
      clearExcl: p('DELETE FROM exclusions'),
      countDocs: p('SELECT COUNT(*) AS n FROM documents'),
      countFacts: p('SELECT COUNT(*) AS n FROM profile_facts')
    }
  }

  /* documents */

  listDocuments(): DocumentRecord[] {
    return (this.stmts.allDocs.all() as Array<Record<string, unknown>>).map(rowToDocument)
  }

  getDocument(sourceId: string): DocumentRecord | undefined {
    const row = this.stmts.getDoc.get(sourceId) as Record<string, unknown> | undefined
    return row ? rowToDocument(row) : undefined
  }

  addDocument(doc: DocumentRecord): void {
    if (doc.status !== 'ready' && doc.status !== 'partial') {
      throw new Error(`Invalid document status: ${String(doc.status)}`)
    }
    this.stmts.insDoc.run(doc.sourceId, doc.displayName, doc.text, doc.status, doc.createdAt, doc.updatedAt)
  }

  removeDocument(sourceId: string): void {
    this.stmts.delDoc.run(sourceId)
    this.stmts.delDocExcl.run(sourceId)
  }

  /* profile facts */

  listFacts(): ProfileFactRecord[] {
    return (this.stmts.allFacts.all() as Array<Record<string, unknown>>).map(rowToFact)
  }

  addFact(fact: ProfileFactRecord): void {
    if (!CATEGORIES.has(fact.category)) {
      throw new Error(`Invalid profile category: ${String(fact.category)}`)
    }
    this.stmts.insFact.run(fact.factId, fact.text, fact.category, fact.origin, fact.createdAt, fact.updatedAt)
  }

  updateFact(factId: string, patch: { text?: string; category?: ProfileCategory }): boolean {
    if (patch.category !== undefined && !CATEGORIES.has(patch.category)) {
      throw new Error(`Invalid profile category: ${String(patch.category)}`)
    }
    const exists = this.stmts.getFact.get(factId)
    if (!exists) return false
    this.stmts.updFact.run(patch.text ?? null, patch.category ?? null, new Date().toISOString(), factId)
    return true
  }

  removeFact(factId: string): boolean {
    const res = this.stmts.delFact.run(factId)
    return Number(res.changes) > 0
  }

  /* exclusions */

  isExcluded(sourceId: string, type: string): boolean {
    return (
      this.stmts.exclExists.get('source', sourceId) !== undefined ||
      this.stmts.exclExists.get('type', type) !== undefined
    )
  }

  setExcluded(sourceId: string | undefined, type: string | undefined, excluded: boolean): void {
    if (sourceId) {
      if (excluded) this.stmts.exclIns.run('source', sourceId)
      else this.stmts.exclDel.run('source', sourceId)
    }
    if (type) {
      if (excluded) this.stmts.exclIns.run('type', type)
      else this.stmts.exclDel.run('type', type)
    }
  }

  /* maintenance */

  clearAll(): void {
    this.stmts.clearDocs.run()
    this.stmts.clearFacts.run()
    this.stmts.clearExcl.run()
  }

  /** Safe, consistent backup via VACUUM INTO (valid under WAL). */
  backup(destPath: string): void {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
      throw new Error('Backup file was not written')
    }
  }

  integrityCheck(): { ok: boolean; message: string } {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    const result = row?.integrity_check ?? 'unknown'
    return { ok: result === 'ok', message: result }
  }

  counts(): { documents: number; facts: number } {
    return {
      documents: Number((this.stmts.countDocs.get() as { n: number }).n),
      facts: Number((this.stmts.countFacts.get() as { n: number }).n)
    }
  }

  /* meetings (user-approved saved records; never auto-created) */

  listMeetings(): MeetingRecord[] {
    return (this.db.prepare('SELECT meeting_id, title, transcript, notes, created_at, updated_at FROM meetings ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(
      (r) => ({
        meetingId: String(r.meeting_id),
        title: String(r.title),
        transcript: String(r.transcript),
        notes: String(r.notes),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at)
      })
    )
  }

  getMeeting(meetingId: string): MeetingRecord | undefined {
    const row = this.db.prepare('SELECT meeting_id, title, transcript, notes, created_at, updated_at FROM meetings WHERE meeting_id = ?').get(meetingId) as Record<string, unknown> | undefined
    return row
      ? {
          meetingId: String(row.meeting_id),
          title: String(row.title),
          transcript: String(row.transcript),
          notes: String(row.notes),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at)
        }
      : undefined
  }

  upsertMeeting(m: MeetingRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meetings (meeting_id, title, transcript, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.meetingId, m.title, m.transcript, m.notes, m.createdAt, m.updatedAt)
  }

  deleteMeeting(meetingId: string): boolean {
    const res = this.db.prepare('DELETE FROM meetings WHERE meeting_id = ?').run(meetingId)
    return Number(res.changes) > 0
  }

  /** In-transaction helper for migration: run fn atomically. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}

function rowToDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    sourceId: String(row.source_id),
    displayName: String(row.display_name),
    text: String(row.text),
    status: row.status === 'partial' ? 'partial' : 'ready',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function rowToFact(row: Record<string, unknown>): ProfileFactRecord {
  return {
    factId: String(row.fact_id),
    text: String(row.text),
    category: String(row.category) as ProfileCategory,
    origin: row.origin === 'model' ? 'model' : 'user',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}
