/**
 * Career Story Bank (Phase 2).
 *
 * Stories are the user's own experience, stored per profile, and reusable during
 * interviews. Two rules shape the code:
 *
 *  1. A draft is never saved automatically. `draft()` only returns text for the
 *     editor; the user reviews and saves it, and only then does it exist.
 *  2. Relevance is deterministic lexical scoring (same philosophy as context
 *     retrieval): every match is explainable, no embeddings, no black box.
 */
import {
  CareerStory,
  RetrievedItem,
  STORY_FRAMEWORK_FIELDS,
  StoryDraftRequest,
  StoryFramework,
  StoryUpsertRequest,
  StoryUpsertRequestSchema
} from '../../../shared/protocol'
import { AIProvider, ProviderError } from '../providers/types'
import type { StoryRecord } from '../context/sqlite-store'

const MAX_RELEVANT = 3
const DRAFT_TIMEOUT_MS = 60_000
const DRAFT_MAX_TOKENS = 900

/** The narrow persistence surface this service needs (mockable in tests). */
export interface StoryStore {
  listStories(profileId?: string): StoryRecord[]
  getStory(storyId: string): StoryRecord | null
  saveStory(story: StoryRecord): void
  deleteStory(storyId: string): boolean
}

export interface StoryDeps {
  store: StoryStore
  getProfileId: () => string
  getFacts: (profileId: string) => string[]
  resolveProvider: () => { provider: AIProvider; model: string } | null
  now?: () => Date
  idFactory?: () => string
}

export interface StoryDraftOutcome {
  ok: boolean
  draft?: Omit<StoryUpsertRequest, 'storyId'>
  providerLabel?: string
  message?: string
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'have', 'has', 'had', 'was', 'were',
  'are', 'our', 'their', 'about', 'into', 'from', 'when', 'what', 'how', 'why', 'can', 'could',
  'would', 'should', 'tell', 'describe', 'give', 'example', 'time', 'did', 'does', 'not', 'but',
  'they', 'them', 'there', 'then', 'than', 'been', 'being', 'will', 'one', 'two', 'also'
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/** Compose the text a story is matched on (and shown as context). */
export function storyText(story: StoryRecord): string {
  return [
    story.title,
    story.skills.join(' '),
    story.role,
    story.situation,
    story.task,
    story.action,
    story.result,
    story.answerFirst
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n')
}

export interface StoryMatch {
  story: StoryRecord
  score: number
  reason: string
}

/**
 * Score stories against a question. Title and skills weigh more than body text
 * because interview questions usually name the competency being probed.
 */
export function rankStories(question: string, stories: StoryRecord[], limit = MAX_RELEVANT): StoryMatch[] {
  const qTokens = tokenize(question)
  if (qTokens.length === 0 || stories.length === 0) return []
  const qSet = new Set(qTokens)

  const matches: StoryMatch[] = []
  for (const story of stories) {
    const titleTokens = new Set(tokenize(story.title))
    const skillTokens = new Set(tokenize(story.skills.join(' ')))
    const bodyTokens = new Set(tokenize(storyText(story)))
    let score = 0
    const reasons: string[] = []
    for (const token of qSet) {
      if (titleTokens.has(token)) {
        score += 3
        reasons.push(`title "${token}"`)
      } else if (skillTokens.has(token)) {
        score += 2.5
        reasons.push(`skill "${token}"`)
      } else if (bodyTokens.has(token)) {
        score += 1
        reasons.push(`text "${token}"`)
      }
    }
    if (score === 0) continue
    // Normalize: a long question should not inflate the score indefinitely.
    const normalized = Math.min(1, score / (Math.sqrt(qSet.size) * 4))
    matches.push({
      story,
      score: Math.round(normalized * 1000) / 1000,
      reason: `matched ${reasons.slice(0, 4).join(', ')}`
    })
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Render one story as a labelled block for prompts. */
export function renderStory(story: StoryRecord): string {
  const fields = STORY_FRAMEWORK_FIELDS[story.framework as StoryFramework] ?? STORY_FRAMEWORK_FIELDS.star
  const lines = [`Story: ${story.title}${story.role ? ` (${story.role})` : ''} [${story.framework.toUpperCase()}]`]
  for (const field of fields) {
    const value =
      field.key === 'answerFirst'
        ? story.answerFirst
        : field.key === 'situation'
          ? story.situation
          : field.key === 'task'
            ? story.task
            : field.key === 'action'
              ? story.action
              : story.result
    if (value.trim().length > 0) lines.push(`${field.label}: ${value.trim()}`)
  }
  if (story.skills.length > 0) lines.push(`Skills: ${story.skills.join(', ')}`)
  return lines.join('\n')
}

export function storiesPromptBlock(matches: StoryMatch[]): string {
  if (matches.length === 0) return ''
  return [
    'VERIFIED CAREER STORIES (the user wrote and saved these; use them, do not invent beyond them):',
    ...matches.map((m) => renderStory(m.story))
  ].join('\n\n')
}

/** Extract the first JSON object from a model response (tolerates fences). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function buildStoryDraftPrompt(framework: StoryFramework, focus: string, facts: string[]): string {
  const fields = (STORY_FRAMEWORK_FIELDS[framework] ?? STORY_FRAMEWORK_FIELDS.star)
    .map((f) => `"${f.key}" (${f.label})`)
    .join(', ')
  return [
    'You draft a career story for a job candidate from the FACTS they confirmed.',
    'Absolute rules:',
    '- Use only the facts provided. Never invent employers, dates, metrics, tools, team sizes or outcomes.',
    '- If a field cannot be supported by the facts, return an empty string for it.',
    '- Do not add advice, commentary or markdown outside the JSON.',
    focus.trim() ? `Angle requested: ${focus.trim()}.` : '',
    `Framework: ${framework.toUpperCase()}. Fields: ${fields}.`,
    'Return STRICT JSON with exactly these keys:',
    `{"title": string, "framework": "${framework}", "situation": string, "task": string, "action": string, "result": string, "answerFirst": string, "skills": string[], "role": string}`,
    '',
    'FACTS:',
    ...facts.map((f) => `- ${f}`)
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

export class StoryBankService {
  constructor(private readonly deps: StoryDeps) {}

  list(): CareerStory[] {
    const profileId = this.deps.getProfileId()
    return this.deps.store.listStories(profileId).map((s) => toCareerStory(s))
  }

  upsert(raw: StoryUpsertRequest): { ok: boolean; story?: CareerStory; message?: string } {
    const parsed = StoryUpsertRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid story fields' }
    const req = parsed.data
    if (req.title.trim().length === 0) return { ok: false, message: 'A story needs a title.' }
    const hasBody = [req.situation, req.task, req.action, req.result, req.answerFirst].some(
      (v) => v.trim().length > 0
    )
    if (!hasBody) return { ok: false, message: 'Add at least one framework field before saving.' }

    const now = (this.deps.now?.() ?? new Date()).toISOString()
    const existing = req.storyId ? this.deps.store.getStory(req.storyId) : null
    if (req.storyId && existing && existing.profileId !== this.deps.getProfileId()) {
      return { ok: false, message: 'That story belongs to another profile.' }
    }
    const record: StoryRecord = {
      storyId: existing?.storyId ?? this.deps.idFactory?.() ?? `story-${Date.now().toString(36)}`,
      profileId: existing?.profileId ?? this.deps.getProfileId(),
      title: req.title.trim(),
      framework: req.framework,
      situation: req.situation.trim(),
      task: req.task.trim(),
      action: req.action.trim(),
      result: req.result.trim(),
      answerFirst: req.answerFirst.trim(),
      skills: req.skills.map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 20),
      role: req.role.trim(),
      // Saving through the editor means the user reviewed it.
      origin: 'user',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    try {
      this.deps.store.saveStory(record)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Could not save the story.' }
    }
    return { ok: true, story: toCareerStory(record) }
  }

  remove(storyId: string): boolean {
    const existing = this.deps.store.getStory(storyId)
    if (!existing || existing.profileId !== this.deps.getProfileId()) return false
    return this.deps.store.deleteStory(storyId)
  }

  /** Story hits shaped like context items, so interview prompts get them free. */
  retrieve(question: string, limit = MAX_RELEVANT): RetrievedItem[] {
    const matches = rankStories(question, this.list(), limit)
    return matches.map((m) => ({
      itemId: `story-${m.story.storyId}`,
      sourceId: `story:${m.story.storyId}`,
      type: 'profile' as const,
      displayName: `Career story: ${m.story.title}`,
      text: renderStory(m.story),
      score: m.score,
      reason: m.reason
    }))
  }

  /** Ready-to-append prompt block with the most relevant verified stories. */
  promptBlock(question: string, limit = MAX_RELEVANT): string {
    return storiesPromptBlock(rankStories(question, this.scopedStories(), limit))
  }

  private scopedStories(): StoryRecord[] {
    return this.deps.store.listStories(this.deps.getProfileId())
  }

  async draft(req: StoryDraftRequest): Promise<StoryDraftOutcome> {
    const resolved = this.deps.resolveProvider()
    if (!resolved) {
      return { ok: false, message: 'No AI provider is configured. Add one in Settings → Providers.' }
    }
    const facts = (req.facts ?? this.deps.getFacts(this.deps.getProfileId()))
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
    if (facts.length === 0) {
      return {
        ok: false,
        message: 'No confirmed profile facts yet. Add facts under Settings → Profile, then draft a story.'
      }
    }

    const signal = AbortSignal.timeout(DRAFT_TIMEOUT_MS)
    let raw = ''
    try {
      for await (const chunk of resolved.provider.chatStream({
        model: resolved.model,
        messages: [
          { role: 'system', content: buildStoryDraftPrompt(req.framework, req.focus, facts) },
          { role: 'user', content: 'Draft the story now as strict JSON.' }
        ],
        signal,
        timeoutMs: DRAFT_TIMEOUT_MS,
        maxTokens: DRAFT_MAX_TOKENS
      })) {
        if (chunk.type === 'delta') raw += chunk.text
      }
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The draft request failed.'
      return { ok: false, providerLabel: resolved.provider.label, message }
    }

    const parsed = extractJsonObject(raw)
    if (!parsed) {
      return {
        ok: false,
        providerLabel: resolved.provider.label,
        message: 'The provider did not return usable JSON. Try again or write the story manually.'
      }
    }
    const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const skillsRaw = parsed['skills']
    const skills = Array.isArray(skillsRaw)
      ? skillsRaw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : []
    const draft = {
      title: asString(parsed['title']).slice(0, 160) || `${req.framework.toUpperCase()} story`,
      framework: req.framework,
      situation: asString(parsed['situation']).slice(0, 4_000),
      task: asString(parsed['task']).slice(0, 4_000),
      action: asString(parsed['action']).slice(0, 6_000),
      result: asString(parsed['result']).slice(0, 4_000),
      answerFirst: asString(parsed['answerFirst']).slice(0, 2_000),
      skills,
      role: asString(parsed['role']).slice(0, 160)
    }
    const body = [draft.situation, draft.task, draft.action, draft.result, draft.answerFirst].some(
      (v) => v.length > 0
    )
    if (!body) {
      return {
        ok: false,
        providerLabel: resolved.provider.label,
        message: 'The model produced an empty story. Add more profile facts or write it manually.'
      }
    }
    return { ok: true, draft, providerLabel: resolved.provider.label }
  }
}

export function toCareerStory(record: StoryRecord): CareerStory {
  return {
    storyId: record.storyId,
    profileId: record.profileId,
    title: record.title,
    framework: (['star', 'car', 'par', 'soar', 'answer-first'] as StoryFramework[]).includes(
      record.framework as StoryFramework
    )
      ? (record.framework as StoryFramework)
      : 'star',
    situation: record.situation,
    task: record.task,
    action: record.action,
    result: record.result,
    answerFirst: record.answerFirst,
    skills: record.skills,
    role: record.role,
    origin: record.origin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}
