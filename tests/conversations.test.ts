/**
 * 0.5.0 persistent conversations.
 *
 * Storage must be profile-scoped, survive restarts, support search over message
 * bodies, and never lose messages when a conversation is renamed/archived.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, SQLiteStore } from '../src/main/services/context/sqlite-store'
import {
  ConversationService,
  deriveTitle,
  MAX_TITLE,
  type ConversationStore
} from '../src/main/services/conversations/conversation-service'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-'))
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

/** Real SQLite store wrapped in the narrow interface the service uses. */
function realStore(): { store: ConversationStore; db: SQLiteStore } {
  const db = new SQLiteStore(path.join(tempDir(), 'context.db'))
  return {
    db,
    store: {
      createConversation: (c) => db.createConversation(c),
      listConversations: (p, q, inc) => db.listConversations(p, q, inc),
      getConversation: (id) => db.getConversation(id),
      listConversationMessages: (id) => db.listConversationMessages(id),
      appendConversationMessage: (m) => db.appendConversationMessage(m),
      renameConversation: (id, t, at) => db.renameConversation(id, t, at),
      setConversationArchived: (id, a, at) => db.setConversationArchived(id, a, at),
      setConversationPinned: (id, p, at) => db.setConversationPinned(id, p, at),
      deleteConversation: (id) => db.deleteConversation(id)
    }
  }
}

function serviceFor(profileId = 'default'): { service: ConversationService; db: SQLiteStore } {
  const { store, db } = realStore()
  let counter = 0
  return {
    db,
    service: new ConversationService({
      store,
      getProfileId: () => profileId,
      now: () => new Date('2026-04-01T09:00:00.000Z'),
      idFactory: () => `conv-${++counter}`
    })
  }
}

describe('title derivation', () => {
  it('uses the first message, single line and bounded', () => {
    expect(deriveTitle('  How do I\n  negotiate salary?  ')).toBe('How do I negotiate salary?')
    expect(deriveTitle('')).toBe('New conversation')
    const long = 'x'.repeat(MAX_TITLE + 40)
    const title = deriveTitle(long)
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('ConversationService', () => {
  it('creates, lists and opens a conversation', () => {
    const { service, db } = serviceFor()
    const created = service.create()
    expect(created.title).toBe('New conversation')
    expect(service.list()).toHaveLength(1)

    service.append({ conversationId: created.conversationId, role: 'user', content: 'Hello there' })
    service.append({ conversationId: created.conversationId, role: 'assistant', content: 'Hi — how can I help?' })

    const detail = service.get(created.conversationId)
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(detail?.messages[1].content).toContain('how can I help')
    expect(detail?.messageCount).toBe(2)
    db.close()
  })

  it('names a default conversation from its first user message', () => {
    const { service, db } = serviceFor()
    const conv = service.create()
    service.append({
      conversationId: conv.conversationId,
      role: 'user',
      content: 'Draft a follow-up email to the recruiter'
    })
    const detail = service.get(conv.conversationId)
    expect(detail?.title).toBe('Draft a follow-up email to the recruiter')
    db.close()
  })

  it('does not overwrite an explicit title', () => {
    const { service, db } = serviceFor()
    const conv = service.create('Salary negotiation')
    service.append({ conversationId: conv.conversationId, role: 'user', content: 'Something else' })
    expect(service.get(conv.conversationId)?.title).toBe('Salary negotiation')
    db.close()
  })

  it('searches titles and message bodies', () => {
    const { service, db } = serviceFor()
    const a = service.create('Interview prep')
    const b = service.create('Travel plans')
    service.append({ conversationId: b.conversationId, role: 'user', content: 'Book a flight to Berlin' })

    expect(service.list('interview').map((c) => c.conversationId)).toEqual([a.conversationId])
    expect(service.list('berlin').map((c) => c.conversationId)).toEqual([b.conversationId])
    expect(service.list('zzz')).toHaveLength(0)
    db.close()
  })

  it('hides archived conversations unless asked', () => {
    const { service, db } = serviceFor()
    const conv = service.create('Old thread')
    expect(service.setArchived(conv.conversationId, true)).toBe(true)
    expect(service.list()).toHaveLength(0)
    expect(service.list('', true)).toHaveLength(1)
    expect(service.list('', true)[0].archived).toBe(true)
    db.close()
  })

  it('keeps pinned conversations first', () => {
    const { service, db } = serviceFor()
    const first = service.create('First')
    const second = service.create('Second')
    service.setPinned(first.conversationId, true)
    const list = service.list()
    expect(list[0].conversationId).toBe(first.conversationId)
    expect(list[0].pinned).toBe(true)
    expect(list[1].conversationId).toBe(second.conversationId)
    db.close()
  })

  it('renames and deletes, including the messages', () => {
    const { service, db } = serviceFor()
    const conv = service.create()
    service.append({ conversationId: conv.conversationId, role: 'user', content: 'Remember this' })
    expect(service.rename(conv.conversationId, '  Renamed  ')).toBe(true)
    expect(service.get(conv.conversationId)?.title).toBe('Renamed')

    expect(service.remove(conv.conversationId)).toBe(true)
    expect(service.get(conv.conversationId)).toBeNull()
    expect(db.listConversationMessages(conv.conversationId)).toHaveLength(0)
    db.close()
  })

  it('refuses to read or write another profile’s conversation', () => {
    const { service: alice, db } = serviceFor('alice')
    const conv = alice.create('Alice private')
    alice.append({ conversationId: conv.conversationId, role: 'user', content: 'secret' })

    const bob = new ConversationService({
      store: {
        createConversation: (c) => db.createConversation(c),
        listConversations: (p, q, inc) => db.listConversations(p, q, inc),
        getConversation: (id) => db.getConversation(id),
        listConversationMessages: (id) => db.listConversationMessages(id),
        appendConversationMessage: (m) => db.appendConversationMessage(m),
        renameConversation: (id, t, at) => db.renameConversation(id, t, at),
        setConversationArchived: (id, a, at) => db.setConversationArchived(id, a, at),
        setConversationPinned: (id, p, at) => db.setConversationPinned(id, p, at),
        deleteConversation: (id) => db.deleteConversation(id)
      },
      getProfileId: () => 'bob'
    })
    expect(bob.list()).toHaveLength(0)
    expect(bob.get(conv.conversationId)).toBeNull()
    expect(bob.append({ conversationId: conv.conversationId, role: 'user', content: 'x' }).ok).toBe(false)
    expect(bob.remove(conv.conversationId)).toBe(false)
    db.close()
  })

  it('rejects empty messages', () => {
    const { service, db } = serviceFor()
    const conv = service.create()
    expect(service.append({ conversationId: conv.conversationId, role: 'user', content: '   ' }).ok).toBe(false)
    db.close()
  })

  it('persists across a reopen', () => {
    const dir = tempDir()
    const file = path.join(dir, 'context.db')
    const db1 = new SQLiteStore(file)
    const store1: ConversationStore = {
      createConversation: (c) => db1.createConversation(c),
      listConversations: (p, q, inc) => db1.listConversations(p, q, inc),
      getConversation: (id) => db1.getConversation(id),
      listConversationMessages: (id) => db1.listConversationMessages(id),
      appendConversationMessage: (m) => db1.appendConversationMessage(m),
      renameConversation: (id, t, at) => db1.renameConversation(id, t, at),
      setConversationArchived: (id, a, at) => db1.setConversationArchived(id, a, at),
      setConversationPinned: (id, p, at) => db1.setConversationPinned(id, p, at),
      deleteConversation: (id) => db1.deleteConversation(id)
    }
    const svc1 = new ConversationService({ store: store1, getProfileId: () => 'default', idFactory: () => 'conv-persist' })
    const conv = svc1.create('Survives restart')
    svc1.append({ conversationId: conv.conversationId, role: 'user', content: 'still here?' })
    db1.close()

    const db2 = new SQLiteStore(file)
    const detail = db2.getConversation('conv-persist')
    expect(detail?.title).toBe('Survives restart')
    expect(db2.listConversationMessages('conv-persist')).toHaveLength(1)
    db2.close()
  })
})

describe('schema v6', () => {
  it('is the current schema and creates the conversation tables', () => {
    expect(SCHEMA_VERSION).toBe(6)
    const dir = tempDir()
    const db = new SQLiteStore(path.join(dir, 'context.db'))
    expect(db.listConversations('default')).toEqual([])
    db.close()
  })

  it('upgrades a v5 database without losing facts', () => {
    const dir = tempDir()
    const file = path.join(dir, 'old.db')
    const raw = new DatabaseSync(file)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profile_facts (
        fact_id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL, origin TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'confirmed', source_text TEXT, source_document_id TEXT
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
      INSERT INTO profile_facts VALUES ('f1', 'Seven years of Go', 'skill', 'user', '2026-01-01', '2026-01-01', 'default', 'confirmed', NULL, NULL);
    `)
    raw.close()
    const db = new SQLiteStore(file)
    expect(db.listFacts('default')).toHaveLength(1)
    expect(db.listConversations('default')).toEqual([])
    db.close()
  })
})
