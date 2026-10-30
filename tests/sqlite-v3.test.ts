import { describe, expect, it, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_PROFILE_ID,
  SQLiteStore,
  SCHEMA_VERSION
} from '../src/main/services/context/sqlite-store'

/**
 * Transformation persistence tests: schema v3 migration (idempotent, no data
 * loss), profiles, meetings with metadata + search, practice persistence.
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-'))
  dirs.push(dir)
  return path.join(dir, 'context.db')
}

/** Build a schema-v2 database by hand (the pre-transformation shape). */
function makeV2Database(p: string): void {
  const db = new DatabaseSync(p)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      source_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready','partial')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE profile_facts (
      fact_id TEXT PRIMARY KEY, text TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('background','skill','preference','project','other')),
      origin TEXT NOT NULL CHECK(origin IN ('user','model')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE exclusions (kind TEXT NOT NULL, key TEXT NOT NULL, UNIQUE(kind, key));
    CREATE TABLE meetings (
      meeting_id TEXT PRIMARY KEY, title TEXT NOT NULL,
      transcript TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '2');
    INSERT INTO documents VALUES ('doc-1', 'resume.pdf', 'Resume text', 'ready', '2026-01-01', '2026-01-01');
    INSERT INTO profile_facts VALUES ('fact-1', 'Seven years of Go', 'skill', 'user', '2026-01-01', '2026-01-01');
    INSERT INTO meetings VALUES ('mtg-old', 'Old meeting', 'old transcript', 'old notes', '2026-01-01', '2026-01-01');
    INSERT INTO exclusions VALUES ('type', 'screen');
  `)
  db.close()
}

describe('schema v3 migration', () => {
  it('upgrades a v2 database without losing data', () => {
    const p = dbPath()
    makeV2Database(p)
    const store = new SQLiteStore(p)
    expect(SCHEMA_VERSION).toBe(3)

    // Existing data preserved.
    expect(store.listDocuments()).toHaveLength(1)
    // Existing facts are assigned to the default profile — never dropped.
    const facts = store.listFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].profileId).toBe(DEFAULT_PROFILE_ID)
    // Meetings survive with the new columns defaulted.
    const meetings = store.listMeetings()
    expect(meetings).toHaveLength(1)
    expect(meetings[0].meetingId).toBe('mtg-old')
    expect(meetings[0].actionItems).toEqual([])
    expect(meetings[0].durationMs).toBeNull()
    // Default profile row exists.
    expect(store.listProfiles().some((pr) => pr.profileId === DEFAULT_PROFILE_ID)).toBe(true)
    // Exclusions preserved.
    expect(store.isExcluded('anything', 'screen')).toBe(true)
    store.close()
  })

  it('migration is idempotent: reopening the v3 database changes nothing', () => {
    const p = dbPath()
    makeV2Database(p)
    const first = new SQLiteStore(p)
    first.close()
    const second = new SQLiteStore(p)
    expect(second.listFacts()).toHaveLength(1)
    expect(second.listMeetings()).toHaveLength(1)
    expect(second.listProfiles().filter((pr) => pr.profileId === DEFAULT_PROFILE_ID)).toHaveLength(1)
    second.close()
  })

  it('a brand-new database is created at v3 with the default profile', () => {
    const p = dbPath()
    const store = new SQLiteStore(p)
    expect(store.listProfiles().map((pr) => pr.profileId)).toEqual([DEFAULT_PROFILE_ID])
    store.close()
  })
})

describe('profiles', () => {
  it('scopes facts per profile and deletes a profile with its facts', () => {
    const p = dbPath()
    const store = new SQLiteStore(p)
    const now = new Date().toISOString()
    store.upsertProfile({ profileId: 'prof-2', name: 'Consulting', createdAt: now, updatedAt: now })
    expect(store.listProfiles().map((pr) => pr.profileId).sort()).toEqual([DEFAULT_PROFILE_ID, 'prof-2'])

    store.addFact({ factId: 'f1', text: 'default fact', category: 'skill', origin: 'user', createdAt: now, updatedAt: now, profileId: DEFAULT_PROFILE_ID })
    store.addFact({ factId: 'f2', text: 'consulting fact', category: 'background', origin: 'user', createdAt: now, updatedAt: now, profileId: 'prof-2' })

    expect(store.listFacts(DEFAULT_PROFILE_ID).map((f) => f.factId)).toEqual(['f1'])
    expect(store.listFacts('prof-2').map((f) => f.factId)).toEqual(['f2'])
    expect(store.countFacts('prof-2')).toBe(1)

    expect(store.renameProfile('prof-2', 'Consulting 2')).toBe(true)
    expect(store.getProfile('prof-2')?.name).toBe('Consulting 2')

    // Deleting a profile removes its facts, not the other profile's.
    expect(store.deleteProfile('prof-2')).toBe(true)
    expect(store.listFacts()).toHaveLength(1)
    expect(store.getProfile('prof-2')).toBeUndefined()
    store.close()
  })
})

describe('meetings v3 record shape', () => {
  it('persists metadata and structured action items', () => {
    const p = dbPath()
    const store = new SQLiteStore(p)
    const now = new Date().toISOString()
    store.upsertMeeting({
      meetingId: 'm1',
      title: 'Sprint planning',
      transcript: '[0:12] Mic: we ship Friday',
      notes: '## Summary\nShipping Friday.',
      createdAt: now,
      updatedAt: now,
      source: 'mic',
      language: 'en',
      providerLabel: 'Groq whisper',
      startedAt: now,
      endedAt: now,
      durationMs: 65_000,
      actionItems: [
        { task: 'Write the changelog', owner: 'Ada', deadline: 'Friday', suggested: false },
        { task: 'Double-check the flags', owner: '(not stated)', deadline: '(not stated)', suggested: true }
      ]
    })
    const m = store.getMeeting('m1')!
    expect(m.title).toBe('Sprint planning')
    expect(m.providerLabel).toBe('Groq whisper')
    expect(m.durationMs).toBe(65_000)
    expect(m.actionItems).toHaveLength(2)
    expect(m.actionItems[0].owner).toBe('Ada')
    expect(m.actionItems[1].suggested).toBe(true)

    // Search hits title, notes and transcript.
    expect(store.searchMeetings('sprint')).toHaveLength(1)
    expect(store.searchMeetings('changelog')).toHaveLength(1)
    expect(store.searchMeetings('ship friday')).toHaveLength(1)
    expect(store.searchMeetings('nonexistent-query')).toHaveLength(0)
    store.close()
  })

  it('corrupt action-items JSON never breaks listing', () => {
    const p = dbPath()
    const store = new SQLiteStore(p)
    const now = new Date().toISOString()
    store.upsertMeeting({ meetingId: 'm2', title: 'x', transcript: '', notes: '', createdAt: now, updatedAt: now, source: null, language: null, providerLabel: null, startedAt: null, endedAt: null, durationMs: null, actionItems: [] })
    store.close()
    const raw = new DatabaseSync(p)
    raw.exec(`UPDATE meetings SET action_items = '{not json' WHERE meeting_id = 'm2'`)
    raw.close()
    const reopened = new SQLiteStore(p)
    expect(reopened.getMeeting('m2')?.actionItems).toEqual([])
    expect(reopened.listMeetings()).toHaveLength(1)
    reopened.close()
  })
})

describe('practice persistence', () => {
  it('sessions and turns survive close/reopen', () => {
    const p = dbPath()
    const store = new SQLiteStore(p)
    const now = new Date().toISOString()
    store.upsertPracticeSession({
      practiceId: 'pr-1', type: 'coding', difficulty: 'hard', questionCount: 3,
      status: 'active', role: 'Backend', jobDescription: 'Build APIs', scorecardJson: null,
      createdAt: now, updatedAt: now
    })
    store.upsertPracticeTurn('pr-1', { index: 1, question: 'Reverse a list', answer: 'Used two pointers', feedbackJson: null, spoken: true })
    store.updatePracticeTurnAnswer('pr-1', 1, 'Used two pointers, O(n)', true)
    const card = JSON.stringify({ overall: 4, communication: 4, technicalAccuracy: 5, relevance: 4, completeness: 3, problemSolving: 4, summary: 'Strong.', areasForImprovement: [] })
    store.updatePracticeStatus('pr-1', 'completed', card)
    store.close()

    const reopened = new SQLiteStore(p)
    const session = reopened.getPracticeSession('pr-1')
    expect(session?.status).toBe('completed')
    expect(session?.scorecardJson).toBe(card)
    const turns = reopened.listPracticeTurns('pr-1')
    expect(turns).toHaveLength(1)
    expect(turns[0].answer).toBe('Used two pointers, O(n)')
    expect(turns[0].spoken).toBe(true)

    // Deleting the session cascades to its turns.
    expect(reopened.deletePracticeSession('pr-1')).toBe(true)
    expect(reopened.listPracticeTurns('pr-1')).toHaveLength(0)
    reopened.close()
  })
})
