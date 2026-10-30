import { describe, expect, it } from 'vitest'
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  InterviewAnswerRequestSchema,
  MeetingSaveRequestSchema,
  PracticeStartRequestSchema,
  SessionPurposeSchema,
  TranscriptPrepareRequestSchema
} from '../src/shared/protocol'
import { ModesService } from '../src/main/services/modes/modes-service'
import { interviewSystemPrompt } from '../src/main/services/modes/prompts'
import { parseActionItems } from '../src/shared/meeting-notes'
import { AIProvider, ChatStreamRequest } from '../src/main/services/providers/types'

/**
 * Transformation contract tests: new zod schemas and the modes-service
 * detail/language/saved-meeting behavior.
 */

describe('protocol: transformation schemas', () => {
  it('transcript prepare defaults to interview purpose and validates others', () => {
    expect(TranscriptPrepareRequestSchema.parse({ source: 'mic' }).purpose).toBe('interview')
    expect(TranscriptPrepareRequestSchema.parse({ source: 'mic', purpose: 'meeting' }).purpose).toBe('meeting')
    expect(SessionPurposeSchema.safeParse('practice').success).toBe(true)
    expect(SessionPurposeSchema.safeParse('stealth').success).toBe(false)
  })

  it('practice start applies safe defaults and bounds', () => {
    const parsed = PracticeStartRequestSchema.parse({ type: 'coding' })
    expect(parsed.difficulty).toBe('medium')
    expect(parsed.questionCount).toBe(5)
    expect(parsed.profileId).toBe('default')
    expect(PracticeStartRequestSchema.safeParse({ type: 'coding', questionCount: 1 }).success).toBe(false)
    expect(PracticeStartRequestSchema.safeParse({ type: 'coding', questionCount: 11 }).success).toBe(false)
    expect(PracticeStartRequestSchema.safeParse({ type: 'puzzle' }).success).toBe(false)
  })

  it('meeting save accepts structured action items and metadata', () => {
    const parsed = MeetingSaveRequestSchema.parse({
      meetingId: 'm1',
      title: 'Sync',
      actionItems: [{ task: 'Ship it', owner: 'Ada', deadline: '(not stated)', suggested: false }],
      source: 'system',
      durationMs: 90_000
    })
    expect(parsed.actionItems).toHaveLength(1)
    expect(MeetingSaveRequestSchema.safeParse({ meetingId: 'm1', title: '', notes: 'x' }).success).toBe(false)
  })

  it('settings gain responseLanguage and activeProfileId with safe defaults', () => {
    const parsed = AppSettingsSchema.parse({})
    expect(parsed.responseLanguage).toBe('auto')
    expect(parsed.activeProfileId).toBe('default')
    expect(DEFAULT_SETTINGS.responseLanguage).toBe('auto')
    expect(AppSettingsSchema.safeParse({ responseLanguage: 'de' }).success).toBe(true)
  })

  it('interview answer carries the separate detail control', () => {
    const parsed = InterviewAnswerRequestSchema.parse({ question: 'Q?', style: 'star' })
    expect(parsed.detail).toBe('concise')
    expect(InterviewAnswerRequestSchema.parse({ question: 'Q?', style: 'star', detail: 'detailed' }).detail).toBe('detailed')
  })
})

describe('interview prompts: detail + response language', () => {
  it('concise vs detailed produce different length instructions', () => {
    const concise = interviewSystemPrompt('star', 'good', 'concise')
    const detailed = interviewSystemPrompt('star', 'good', 'detailed')
    expect(concise).toContain('hard maximum ~150 words')
    expect(detailed).toContain('fuller answer is welcome')
  })

  it('response language adds an instruction; auto adds none', () => {
    expect(interviewSystemPrompt('star', 'good', 'concise', 'de')).toContain('write your response in de')
    expect(interviewSystemPrompt('star', 'good', 'concise', 'auto')).not.toContain('LANGUAGE')
  })
})

describe('modes service: meeting ask against a saved meeting', () => {
  function fakeRecordingProvider(): { provider: AIProvider; requests: ChatStreamRequest[] } {
    const requests: ChatStreamRequest[] = []
    const provider: AIProvider = {
      id: 'p',
      label: 'Fake',
      capabilities: () => ({ chat: true, streaming: true, vision: false, transcription: false }),
      async *chatStream(req: ChatStreamRequest) {
        requests.push(req)
        yield { type: 'delta', text: 'From the saved transcript: Friday.' }
      },
      testConnection: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 1 })
    }
    return { provider, requests }
  }

  it('uses the saved meeting transcript when meetingId is set (never the live session)', async () => {
    const { provider, requests } = fakeRecordingProvider()
    const service = new ModesService({
      resolveProvider: () => ({ provider, model: 'm' }),
      retrieve: () => ({ items: [], estimatedTokens: 0, block: '' }),
      getSessionId: () => 'live-session',
      getSavedMeetingTranscript: (id) => (id === 'saved-1' ? '[0:10] Mic: we decided on Friday' : null),
      saveText: async () => ({ ok: true })
    })
    const res = service.meetingAsk({ question: 'When do we ship?', meetingId: 'saved-1' })
    expect(res.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    const req = requests[0]
    expect(JSON.stringify(req.messages)).toContain('we decided on Friday')
  })

  it('rejects asking about an unknown saved meeting', () => {
    const { provider } = fakeRecordingProvider()
    const service = new ModesService({
      resolveProvider: () => ({ provider, model: 'm' }),
      retrieve: () => ({ items: [], estimatedTokens: 0, block: '' }),
      getSessionId: () => null,
      getSavedMeetingTranscript: () => null,
      saveText: async () => ({ ok: true })
    })
    const res = service.meetingAsk({ question: 'hi', meetingId: 'nope' })
    expect(res.ok).toBe(false)
  })

  it('live-session ask still works without a meetingId', async () => {
    const { provider, requests } = fakeRecordingProvider()
    const service = new ModesService({
      resolveProvider: () => ({ provider, model: 'm' }),
      retrieve: () => ({ items: [], estimatedTokens: 0, block: '' }),
      getSessionId: () => 'live-session',
      saveText: async () => ({ ok: true })
    })
    const res = service.meetingAsk({ question: 'hi' })
    expect(res.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(requests).toHaveLength(1)
  })
})

describe('action item parsing (client-side, meeting notes)', () => {
  it('parses owners and deadlines from the generated notes section', async () => {
    const notes = [
      '## Summary',
      'We shipped.',
      '## Action items',
      '- Update the docs — Owner: Ada — Deadline: Friday',
      '- Book the review — Owner: (not stated) — Deadline: (not stated)',
      '## Uncertain / needs follow-up',
      '- Audio was unclear'
    ].join('\n')
    const items = parseActionItems(notes)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ task: 'Update the docs', owner: 'Ada', deadline: 'Friday', suggested: false })
    expect(items[1].owner).toBe('(not stated)')
  })

  it('returns nothing when there is no action-items section', async () => {
    expect(parseActionItems('## Summary\nNothing.')).toEqual([])
  })
})
