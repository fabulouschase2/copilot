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

export const SCHEMA_VERSION = 3

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
  profileId: string
}

export interface ProfileRecord {
  profileId: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface MeetingActionItemRecord {
  task: string
  owner: string
  deadline: string
  suggested: boolean
}

const CATEGORIES = new Set(['background', 'skill', 'preference', 'project', 'other'])

export const DEFAULT_PROFILE_ID = 'default'
export const DEFAULT_PROFILE_NAME = 'Default'

export interface MeetingRecord {
  meetingId: string
  title: string
  transcript: string
  notes: string
  createdAt: string
  updatedAt: string
  source: 'mic' | 'system' | null
  language: string | null
  providerLabel: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  actionItems: MeetingActionItemRecord[]
}

export interface PracticeTurnRecord {
  index: number
  question: string
  answer: string
  /** JSON-serialized PracticeFeedback, null until evaluated. */
  feedbackJson: string | null
  spoken: boolean
}

export interface PracticeSessionRecord {
  practiceId: string
  type: string
  difficulty: string
  questionCount: number
  status: 'active' | 'completed' | 'cancelled'
  role: string
  jobDescription: string
  /** JSON-serialized PracticeScorecard, null until finished. */
  scorecardJson: string | null
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
    // v2 → v3: profiles, per-profile facts, meeting metadata, practice sessions.
    if (current < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
          profile_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS practice_sessions (
          practice_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          difficulty TEXT NOT NULL,
          question_count INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')),
          role TEXT NOT NULL DEFAULT '',
          job_description TEXT NOT NULL DEFAULT '',
          scorecard_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS practice_turns (
          practice_id TEXT NOT NULL REFERENCES practice_sessions(practice_id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          feedback_json TEXT,
          spoken INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (practice_id, idx)
        );
      `)
      // Additive columns on existing tables (idempotent via column checks).
      const meetingCols = this.columns('meetings')
      if (!meetingCols.has('source')) this.db.exec("ALTER TABLE meetings ADD COLUMN source TEXT")
      if (!meetingCols.has('language')) this.db.exec("ALTER TABLE meetings ADD COLUMN language TEXT")
      if (!meetingCols.has('provider_label')) this.db.exec("ALTER TABLE meetings ADD COLUMN provider_label TEXT")
      if (!meetingCols.has('started_at')) this.db.exec("ALTER TABLE meetings ADD COLUMN started_at TEXT")
      if (!meetingCols.has('ended_at')) this.db.exec("ALTER TABLE meetings ADD COLUMN ended_at TEXT")
      if (!meetingCols.has('duration_ms')) this.db.exec('ALTER TABLE meetings ADD COLUMN duration_ms INTEGER')
      if (!meetingCols.has('action_items')) this.db.exec("ALTER TABLE meetings ADD COLUMN action_items TEXT NOT NULL DEFAULT '[]'")
      const factCols = this.columns('profile_facts')
      if (!factCols.has('profile_id')) {
        // Existing facts belong to the default profile — never dropped.
        this.db.exec(`ALTER TABLE profile_facts ADD COLUMN profile_id TEXT NOT NULL DEFAULT '${DEFAULT_PROFILE_ID}'`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_facts_profile ON profile_facts(profile_id)`)
      }
      // Ensure the default profile row exists and backfill it if absent.
      const now = new Date().toISOString()
      this.db
        .prepare('INSERT OR IGNORE INTO profiles (profile_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME, now, now)
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', '3')
    }
  }

  /** Column names of a table (safe for a missing table → empty set). */
  private columns(table: string): Set<string> {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>
      return new Set(rows.map((r) => String(r.name)))
    } catch {
      return new Set()
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
    insProfile: ReturnType<DatabaseSync['prepare']>
    allProfiles: ReturnType<DatabaseSync['prepare']>
    getProfile: ReturnType<DatabaseSync['prepare']>
    updProfile: ReturnType<DatabaseSync['prepare']>
    delProfile: ReturnType<DatabaseSync['prepare']>
    delProfileFacts: ReturnType<DatabaseSync['prepare']>
    countFactsByProfile: ReturnType<DatabaseSync['prepare']>
    insPractice: ReturnType<DatabaseSync['prepare']>
    allPractice: ReturnType<DatabaseSync['prepare']>
    getPractice: ReturnType<DatabaseSync['prepare']>
    delPractice: ReturnType<DatabaseSync['prepare']>
    insTurn: ReturnType<DatabaseSync['prepare']>
    allTurns: ReturnType<DatabaseSync['prepare']>
    updTurnAnswer: ReturnType<DatabaseSync['prepare']>
    updPractice: ReturnType<DatabaseSync['prepare']>
    searchMeetings: ReturnType<DatabaseSync['prepare']>
  }

  private prepare(): void {
    const p = this.db.prepare.bind(this.db)
    this.stmts = {
      insDoc: p('INSERT OR REPLACE INTO documents (source_id, display_name, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      allDocs: p('SELECT source_id, display_name, text, status, created_at, updated_at FROM documents ORDER BY created_at'),
      getDoc: p('SELECT source_id, display_name, text, status, created_at, updated_at FROM documents WHERE source_id = ?'),
      delDoc: p('DELETE FROM documents WHERE source_id = ?'),
      delDocExcl: p("DELETE FROM exclusions WHERE kind = 'source' AND key = ?"),
      insFact: p('INSERT OR REPLACE INTO profile_facts (fact_id, text, category, origin, created_at, updated_at, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      allFacts: p('SELECT fact_id, text, category, origin, created_at, updated_at, profile_id FROM profile_facts ORDER BY created_at'),
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
      countFacts: p('SELECT COUNT(*) AS n FROM profile_facts'),
      insProfile: p('INSERT OR REPLACE INTO profiles (profile_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'),
      allProfiles: p('SELECT profile_id, name, created_at, updated_at FROM profiles ORDER BY created_at'),
      getProfile: p('SELECT profile_id, name, created_at, updated_at FROM profiles WHERE profile_id = ?'),
      updProfile: p('UPDATE profiles SET name = ?, updated_at = ? WHERE profile_id = ?'),
      delProfile: p('DELETE FROM profiles WHERE profile_id = ?'),
      delProfileFacts: p('DELETE FROM profile_facts WHERE profile_id = ?'),
      countFactsByProfile: p('SELECT COUNT(*) AS n FROM profile_facts WHERE profile_id = ?'),
      insPractice: p('INSERT OR REPLACE INTO practice_sessions (practice_id, type, difficulty, question_count, status, role, job_description, scorecard_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      allPractice: p('SELECT practice_id, type, difficulty, question_count, status, role, job_description, scorecard_json, created_at, updated_at FROM practice_sessions ORDER BY updated_at DESC'),
      getPractice: p('SELECT practice_id, type, difficulty, question_count, status, role, job_description, scorecard_json, created_at, updated_at FROM practice_sessions WHERE practice_id = ?'),
      delPractice: p('DELETE FROM practice_sessions WHERE practice_id = ?'),
      insTurn: p('INSERT OR REPLACE INTO practice_turns (practice_id, idx, question, answer, feedback_json, spoken) VALUES (?, ?, ?, ?, ?, ?)'),
      allTurns: p('SELECT idx, question, answer, feedback_json, spoken FROM practice_turns WHERE practice_id = ? ORDER BY idx'),
      updTurnAnswer: p('UPDATE practice_turns SET answer = ?, spoken = ? WHERE practice_id = ? AND idx = ?'),
      updPractice: p('UPDATE practice_sessions SET status = ?, scorecard_json = ?, updated_at = ? WHERE practice_id = ?'),
      searchMeetings: p("SELECT meeting_id, title, transcript, notes, created_at, updated_at, source, language, provider_label, started_at, ended_at, duration_ms, action_items FROM meetings WHERE title LIKE ? OR notes LIKE ? OR transcript LIKE ? ORDER BY updated_at DESC")
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

  /* profile facts (scoped to a personal profile) */

  listFacts(profileId?: string): ProfileFactRecord[] {
    const all = (this.stmts.allFacts.all() as Array<Record<string, unknown>>).map(rowToFact)
    return profileId ? all.filter((f) => f.profileId === profileId) : all
  }

  addFact(fact: ProfileFactRecord): void {
    if (!CATEGORIES.has(fact.category)) {
      throw new Error(`Invalid profile category: ${String(fact.category)}`)
    }
    this.stmts.insFact.run(fact.factId, fact.text, fact.category, fact.origin, fact.createdAt, fact.updatedAt, fact.profileId)
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

  /* profiles */

  listProfiles(): ProfileRecord[] {
    return (this.stmts.allProfiles.all() as Array<Record<string, unknown>>).map(rowToProfile)
  }

  getProfile(profileId: string): ProfileRecord | undefined {
    const row = this.stmts.getProfile.get(profileId) as Record<string, unknown> | undefined
    return row ? rowToProfile(row) : undefined
  }

  upsertProfile(profile: ProfileRecord): void {
    this.stmts.insProfile.run(profile.profileId, profile.name, profile.createdAt, profile.updatedAt)
  }

  renameProfile(profileId: string, name: string): boolean {
    const res = this.stmts.updProfile.run(name, new Date().toISOString(), profileId)
    return Number(res.changes) > 0
  }

  /** Deletes the profile AND its facts. The default profile is protected upstream. */
  deleteProfile(profileId: string): boolean {
    this.stmts.delProfileFacts.run(profileId)
    const res = this.stmts.delProfile.run(profileId)
    return Number(res.changes) > 0
  }

  countFacts(profileId: string): number {
    return Number((this.stmts.countFactsByProfile.get(profileId) as { n: number }).n)
  }

  /* meetings (user-approved saved records; never auto-created) */

  listMeetings(): MeetingRecord[] {
    return (this.db
      .prepare('SELECT meeting_id, title, transcript, notes, created_at, updated_at, source, language, provider_label, started_at, ended_at, duration_ms, action_items FROM meetings ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>).map(rowToMeeting)
  }

  searchMeetings(query: string): MeetingRecord[] {
    const like = `%${query.replace(/[%_]/g, '')}%`
    return (this.stmts.searchMeetings.all(like, like, like) as Array<Record<string, unknown>>).map(rowToMeeting)
  }

  getMeeting(meetingId: string): MeetingRecord | undefined {
    const row = this.db
      .prepare('SELECT meeting_id, title, transcript, notes, created_at, updated_at, source, language, provider_label, started_at, ended_at, duration_ms, action_items FROM meetings WHERE meeting_id = ?')
      .get(meetingId) as Record<string, unknown> | undefined
    return row ? rowToMeeting(row) : undefined
  }

  upsertMeeting(m: MeetingRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meetings (meeting_id, title, transcript, notes, created_at, updated_at, source, language, provider_label, started_at, ended_at, duration_ms, action_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        m.meetingId,
        m.title,
        m.transcript,
        m.notes,
        m.createdAt,
        m.updatedAt,
        m.source,
        m.language,
        m.providerLabel,
        m.startedAt,
        m.endedAt,
        m.durationMs,
        JSON.stringify(m.actionItems)
      )
  }

  deleteMeeting(meetingId: string): boolean {
    const res = this.db.prepare('DELETE FROM meetings WHERE meeting_id = ?').run(meetingId)
    return Number(res.changes) > 0
  }

  /* practice sessions */

  listPracticeSessions(): PracticeSessionRecord[] {
    return (this.stmts.allPractice.all() as Array<Record<string, unknown>>).map(rowToPractice)
  }

  getPracticeSession(practiceId: string): PracticeSessionRecord | undefined {
    const row = this.stmts.getPractice.get(practiceId) as Record<string, unknown> | undefined
    return row ? rowToPractice(row) : undefined
  }

  upsertPracticeSession(s: PracticeSessionRecord): void {
    this.stmts.insPractice.run(
      s.practiceId, s.type, s.difficulty, s.questionCount, s.status, s.role, s.jobDescription, s.scorecardJson, s.createdAt, s.updatedAt
    )
  }

  updatePracticeStatus(practiceId: string, status: PracticeSessionRecord['status'], scorecardJson: string | null): boolean {
    const res = this.stmts.updPractice.run(status, scorecardJson, new Date().toISOString(), practiceId)
    return Number(res.changes) > 0
  }

  deletePracticeSession(practiceId: string): boolean {
    const res = this.stmts.delPractice.run(practiceId)
    return Number(res.changes) > 0
  }

  listPracticeTurns(practiceId: string): PracticeTurnRecord[] {
    return (this.stmts.allTurns.all(practiceId) as Array<Record<string, unknown>>).map((r) => ({
      index: Number(r.idx),
      question: String(r.question),
      answer: String(r.answer),
      feedbackJson: r.feedback_json === null ? null : String(r.feedback_json),
      spoken: Number(r.spoken) === 1
    }))
  }

  upsertPracticeTurn(practiceId: string, turn: PracticeTurnRecord): void {
    this.stmts.insTurn.run(practiceId, turn.index, turn.question, turn.answer, turn.feedbackJson, turn.spoken ? 1 : 0)
  }

  updatePracticeTurnAnswer(practiceId: string, index: number, answer: string, spoken: boolean): boolean {
    const res = this.stmts.updTurnAnswer.run(answer, spoken ? 1 : 0, practiceId, index)
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
    updatedAt: String(row.updated_at),
    profileId: row.profile_id === undefined ? DEFAULT_PROFILE_ID : String(row.profile_id)
  }
}

function rowToProfile(row: Record<string, unknown>): ProfileRecord {
  return {
    profileId: String(row.profile_id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function rowToMeeting(row: Record<string, unknown>): MeetingRecord {
  let actionItems: MeetingActionItemRecord[] = []
  try {
    const raw = row.action_items
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        actionItems = parsed
          .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
          .map((a) => ({
            task: String(a.task ?? ''),
            owner: String(a.owner ?? '(not stated)'),
            deadline: String(a.deadline ?? '(not stated)'),
            suggested: a.suggested === true
          }))
          .filter((a) => a.task.length > 0)
      }
    }
  } catch {
    actionItems = [] // corrupt JSON must never break listing
  }
  return {
    meetingId: String(row.meeting_id),
    title: String(row.title),
    transcript: String(row.transcript),
    notes: String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    source: row.source === 'mic' || row.source === 'system' ? (row.source as 'mic' | 'system') : null,
    language: row.language === null || row.language === undefined ? null : String(row.language),
    providerLabel: row.provider_label === null || row.provider_label === undefined ? null : String(row.provider_label),
    startedAt: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    actionItems
  }
}

function rowToPractice(row: Record<string, unknown>): PracticeSessionRecord {
  return {
    practiceId: String(row.practice_id),
    type: String(row.type),
    difficulty: String(row.difficulty),
    questionCount: Number(row.question_count),
    status: row.status === 'completed' ? 'completed' : row.status === 'cancelled' ? 'cancelled' : 'active',
    role: String(row.role ?? ''),
    jobDescription: String(row.job_description ?? ''),
    scorecardJson: row.scorecard_json === null || row.scorecard_json === undefined ? null : String(row.scorecard_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}
