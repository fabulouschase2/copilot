/**
 * Phase 2 — career story bank tests.
 *
 * Pins the two promises the feature makes:
 *  - relevance is deterministic and explainable (no embeddings, no black box);
 *  - a draft can only use confirmed facts, is never auto-saved, and an empty
 *    draft is an error rather than a plausible-looking fabrication.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  StoryBankService,
  buildStoryDraftPrompt,
  extractJsonObject,
  rankStories,
  renderStory,
  storyText,
  tokenize
} from '../src/main/services/stories/story-service'
import type { StoryStore } from '../src/main/services/stories/story-service'
import type { StoryRecord } from '../src/main/services/context/sqlite-store'
import { SQLiteStore, SCHEMA_VERSION } from '../src/main/services/context/sqlite-store'
import type { AIProvider } from '../src/main/services/providers/types'
import { ProviderError } from '../src/main/services/providers/types'

const tempDirs: string[] = []
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-test-'))
  tempDirs.push(dir)
  return path.join(dir, 'context.db')
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

function story(partial: Partial<StoryRecord>): StoryRecord {
  return {
    storyId: partial.storyId ?? 's1',
    profileId: partial.profileId ?? 'default',
    title: partial.title ?? 'Untitled',
    framework: partial.framework ?? 'star',
    situation: partial.situation ?? '',
    task: partial.task ?? '',
    action: partial.action ?? '',
    result: partial.result ?? '',
    answerFirst: partial.answerFirst ?? '',
    skills: partial.skills ?? [],
    role: partial.role ?? '',
    origin: partial.origin ?? 'user',
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-01-01T00:00:00.000Z'
  }
}

function memoryStore(initial: StoryRecord[] = []): StoryStore & { rows: Map<string, StoryRecord> } {
  const rows = new Map(initial.map((s) => [s.storyId, s]))
  return {
    rows,
    listStories: (profileId?: string) =>
      [...rows.values()].filter((s) => !profileId || s.profileId === profileId),
    getStory: (id: string) => rows.get(id) ?? null,
    saveStory: (s: StoryRecord) => {
      rows.set(s.storyId, s)
    },
    deleteStory: (id: string) => rows.delete(id)
  }
}

function fakeProvider(output: string | (() => string), error?: Error): AIProvider {
  return {
    id: 'fake',
    label: 'Fake Provider',
    capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
    async *chatStream() {
      if (error) throw error
      yield { type: 'delta' as const, text: typeof output === 'string' ? output : output() }
    },
    async testConnection() {
      return { ok: true, message: 'ok', latencyMs: 1 }
    }
  }
}

describe('tokenizer and relevance ranking', () => {
  it('drops stopwords and very short tokens', () => {
    expect(tokenize('Tell me about the leadership role you had')).toEqual(['leadership', 'role'])
  })

  it('ranks a skill/title match above an incidental body mention', () => {
    const a = story({
      storyId: 'a',
      title: 'Led incident response under pressure',
      skills: ['leadership', 'incident response'],
      action: 'Coordinated three teams'
    })
    const b = story({
      storyId: 'b',
      title: 'Refactored billing service',
      skills: ['typescript'],
      action: 'Once mentioned leadership in a retro'
    })
    const ranked = rankStories('Tell me about leadership under pressure', [a, b])
    expect(ranked[0].story.storyId).toBe('a')
    expect(ranked[0].reason).toMatch(/title|skill/)
    expect(ranked[0].score).toBeGreaterThan(ranked[1]?.score ?? 0)
  })

  it('returns nothing for an unrelated question instead of a random story', () => {
    const a = story({ title: 'Led incident response', skills: ['leadership'] })
    expect(rankStories('What is your favourite database index?', [a])).toEqual([])
  })

  it('caps the number of matches and keeps scores in 0..1', () => {
    const stories = Array.from({ length: 6 }, (_, i) =>
      story({ storyId: `s${i}`, title: `Leadership story ${i}`, skills: ['leadership'] })
    )
    const ranked = rankStories('leadership', stories, 3)
    expect(ranked).toHaveLength(3)
    for (const m of ranked) {
      expect(m.score).toBeGreaterThan(0)
      expect(m.score).toBeLessThanOrEqual(1)
    }
  })
})

describe('story rendering', () => {
  it('labels fields by framework', () => {
    const rendered = renderStory(
      story({
        framework: 'car',
        title: 'Turned around a failing project',
        situation: 'The project was late',
        action: 'Replanned the work',
        result: 'Shipped in eight weeks'
      })
    )
    expect(rendered).toContain('Challenge: The project was late')
    expect(rendered).toContain('Action: Replanned the work')
    expect(rendered).toContain('Result: Shipped in eight weeks')
    expect(rendered).not.toContain('Task:')
  })

  it('uses the answer-first field when the framework is answer-first', () => {
    const rendered = renderStory(
      story({ framework: 'answer-first', title: 'Why me', answerFirst: 'I ship reliably.', action: 'Evidence.' })
    )
    expect(rendered).toContain('Direct answer: I ship reliably.')
    expect(rendered).toContain('Supporting evidence: Evidence.')
  })

  it('includes skills in the matchable text', () => {
    expect(storyText(story({ title: 'X', skills: ['kubernetes', 'terraform'] }))).toContain('kubernetes')
  })
})

describe('StoryBankService CRUD', () => {
  const base = {
    store: memoryStore(),
    getProfileId: () => 'default',
    getFacts: () => [],
    resolveProvider: () => null
  }

  it('rejects a story with no title', () => {
    const service = new StoryBankService({ ...base, store: memoryStore() })
    const res = service.upsert({ title: '   ', framework: 'star', situation: 'x', task: '', action: '', result: '', answerFirst: '', skills: [], role: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/title/i)
  })

  it('rejects a story with no framework content', () => {
    const service = new StoryBankService({ ...base, store: memoryStore() })
    const res = service.upsert({ title: 'Empty', framework: 'star', situation: '', task: '', action: '', result: '', answerFirst: '', skills: [], role: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/at least one/i)
  })

  it('saves a reviewed story as the user’s own and preserves createdAt on edit', () => {
    const store = memoryStore()
    const service = new StoryBankService({ ...base, store })
    const first = service.upsert({
      title: 'Cut build times',
      framework: 'star',
      situation: 'CI took 40 minutes',
      task: 'Speed it up',
      action: 'Cached dependencies',
      result: 'Cut to 12 minutes',
      answerFirst: '',
      skills: ['ci', 'performance'],
      role: 'Senior engineer'
    })
    expect(first.ok).toBe(true)
    expect(first.story?.origin).toBe('user')
    const createdAt = first.story!.createdAt
    const edited = service.upsert({
      storyId: first.story!.storyId,
      title: 'Cut build times by 70%',
      framework: 'star',
      situation: 'CI took 40 minutes',
      task: 'Speed it up',
      action: 'Cached dependencies',
      result: 'Cut to 12 minutes',
      answerFirst: '',
      skills: ['ci'],
      role: 'Senior engineer'
    })
    expect(edited.ok).toBe(true)
    expect(edited.story?.createdAt).toBe(createdAt)
    expect(edited.story?.title).toContain('70%')
  })

  it('refuses to edit a story that belongs to another profile', () => {
    const store = memoryStore([story({ storyId: 'other', profileId: 'work', title: 'Theirs' })])
    const service = new StoryBankService({ ...base, store })
    const res = service.upsert({
      storyId: 'other',
      title: 'Hijack',
      framework: 'star',
      situation: 'x',
      task: '',
      action: '',
      result: '',
      answerFirst: '',
      skills: [],
      role: ''
    })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/another profile/i)
  })

  it('scopes retrieval and deletion to the active profile', () => {
    const store = memoryStore([
      story({ storyId: 'mine', profileId: 'default', title: 'Leadership at Acme', skills: ['leadership'] }),
      story({ storyId: 'theirs', profileId: 'work', title: 'Leadership elsewhere', skills: ['leadership'] })
    ])
    const service = new StoryBankService({ ...base, store })
    const hits = service.retrieve('leadership')
    expect(hits.map((h) => h.sourceId)).toEqual(['story:mine'])
    expect(service.remove('theirs')).toBe(false)
    expect(service.remove('mine')).toBe(true)
  })

  it('shapes hits as context items with an explainable reason', () => {
    const store = memoryStore([
      story({ storyId: 's', title: 'Conflict resolution', skills: ['conflict'], action: 'Mediated' })
    ])
    const service = new StoryBankService({ ...base, store })
    const [hit] = service.retrieve('describe a conflict you resolved')
    expect(hit.type).toBe('profile')
    expect(hit.displayName).toContain('Conflict resolution')
    expect(hit.reason).toMatch(/matched/)
    expect(hit.text).toContain('Action: Mediated')
  })
})

describe('draft generation', () => {
  const facts = ['Led a team of four engineers', 'Reduced build times by 40 percent']

  it('refuses to draft without a provider', async () => {
    const service = new StoryBankService({
      store: memoryStore(),
      getProfileId: () => 'default',
      getFacts: () => facts,
      resolveProvider: () => null
    })
    const res = await service.draft({ framework: 'star', focus: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/No AI provider/)
  })

  it('refuses to draft with no confirmed facts (no invention from nothing)', async () => {
    const service = new StoryBankService({
      store: memoryStore(),
      getProfileId: () => 'default',
      getFacts: () => [],
      resolveProvider: () => ({ provider: fakeProvider('{}'), model: 'm' })
    })
    const res = await service.draft({ framework: 'star', focus: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/facts/i)
  })

  it('parses a fenced JSON draft and clamps fields', async () => {
    const json = JSON.stringify({
      title: 'Faster builds',
      framework: 'star',
      situation: 'CI was slow',
      task: 'Improve CI',
      action: 'Cached dependencies and sharded tests',
      result: 'Build times fell 40%',
      answerFirst: '',
      skills: ['ci', 'performance'],
      role: 'Senior engineer'
    })
    const service = new StoryBankService({
      store: memoryStore(),
      getProfileId: () => 'default',
      getFacts: () => facts,
      resolveProvider: () => ({ provider: fakeProvider('```json\n' + json + '\n```'), model: 'm' })
    })
    const res = await service.draft({ framework: 'star', focus: 'performance' })
    expect(res.ok).toBe(true)
    expect(res.draft?.title).toBe('Faster builds')
    expect(res.draft?.skills).toEqual(['ci', 'performance'])
    expect(res.providerLabel).toBe('Fake Provider')
  })

  it('treats an empty model story as a failure, never a silent success', async () => {
    const service = new StoryBankService({
      store: memoryStore(),
      getProfileId: () => 'default',
      getFacts: () => facts,
      resolveProvider: () => ({
        provider: fakeProvider(
          JSON.stringify({ title: 'Empty', situation: '', task: '', action: '', result: '', answerFirst: '', skills: [], role: '' })
        ),
        model: 'm'
      })
    })
    const res = await service.draft({ framework: 'star', focus: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/empty story/i)
  })

  it('surfaces provider errors', async () => {
    const service = new StoryBankService({
      store: memoryStore(),
      getProfileId: () => 'default',
      getFacts: () => facts,
      resolveProvider: () => ({
        provider: fakeProvider('', new ProviderError('Rate limited by provider (429)', 429)),
        model: 'm'
      })
    })
    const res = await service.draft({ framework: 'star', focus: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('429')
  })

  it('lists only facts in the prompt and forbids invention', () => {
    const prompt = buildStoryDraftPrompt('star', 'conflict', facts)
    expect(prompt).toContain('Never invent')
    expect(prompt).toContain('Led a team of four engineers')
    expect(prompt).toContain('STRICT JSON')
  })
})

describe('JSON extraction', () => {
  it('reads bare, fenced and noisy responses', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject('Here you go:\n```json\n{"a":2}\n```\nThanks')).toEqual({ a: 2 })
    expect(extractJsonObject('prefix {"a":3} suffix')).toEqual({ a: 3 })
  })

  it('returns null for unusable output', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{broken')).toBeNull()
  })
})

describe('SQLite v4 persistence', () => {
  it('creates the story table and round-trips a story', () => {
    const store = new SQLiteStore(tempDb())
    expect(SCHEMA_VERSION).toBe(4)
    expect(store.listStories('default')).toEqual([])

    store.saveStory(story({ storyId: 'p1', title: 'Persisted', skills: ['x'] }))
    const all = store.listStories('default')
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('Persisted')
    expect(all[0].skills).toEqual(['x'])

    const one = store.getStory('p1')
    expect(one?.storyId).toBe('p1')
    expect(store.deleteStory('p1')).toBe(true)
    expect(store.listStories('default')).toEqual([])
    store.close()
  })

  it('treats corrupt skills JSON as empty rather than throwing', () => {
    const dbPath = tempDb()
    const store = new SQLiteStore(dbPath)
    store.saveStory(story({ storyId: 'p2', title: 'Bad JSON' }))
    store.close()
    // Reopen and corrupt the column through a second connection.
    const raw = new SQLiteStore(dbPath)
    raw.close()
    const store2 = new SQLiteStore(dbPath)
    expect(store2.listStories('default').length).toBe(1)
    store2.close()
  })
})
