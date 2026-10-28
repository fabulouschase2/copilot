import { describe, expect, it } from 'vitest'
import {
  AnswerStyleSchema,
  InterviewAnswerRequestSchema,
  MeetingAskRequestSchema,
  MeetingGenerateRequestSchema,
  NotesExportRequestSchema
} from '../src/shared/protocol'

describe('Stage 8 IPC boundary validation (security)', () => {
  it('interview requests validate question, style, and defaults', () => {
    const parsed = InterviewAnswerRequestSchema.parse({ question: 'q?', style: 'star' })
    expect(parsed.includeSession).toBe(false)
    expect(() => InterviewAnswerRequestSchema.parse({ question: '', style: 'star' })).toThrow()
    expect(() => InterviewAnswerRequestSchema.parse({ question: 'q'.repeat(2_001), style: 'star' })).toThrow()
    expect(() => InterviewAnswerRequestSchema.parse({ question: 'q', style: 'speak-it' })).toThrow()
    expect(AnswerStyleSchema.options).toEqual(['concise', 'detailed', 'technical', 'star', 'coding', 'research'])
  })

  it('meeting requests validate kind and saved-source opt-ins', () => {
    expect(MeetingGenerateRequestSchema.parse({ kind: 'summary' }).includeDocuments).toBe(false)
    expect(() => MeetingGenerateRequestSchema.parse({ kind: 'transcript' })).toThrow()
    expect(() => MeetingAskRequestSchema.parse({ question: '' })).toThrow()
    expect(() => MeetingAskRequestSchema.parse({ question: 'x'.repeat(2_001) })).toThrow()
  })

  it('notes export is bounded and format-checked', () => {
    expect(NotesExportRequestSchema.parse({ content: 'notes', format: 'markdown' }).format).toBe('markdown')
    expect(() => NotesExportRequestSchema.parse({ content: '', format: 'txt' })).toThrow()
    expect(() => NotesExportRequestSchema.parse({ content: 'x'.repeat(1_000_001), format: 'txt' })).toThrow()
    expect(() => NotesExportRequestSchema.parse({ content: 'x', format: 'exe' })).toThrow()
    // no path field exists — the save location is chosen by the OS dialog
    expect(Object.keys(NotesExportRequestSchema.shape)).toEqual(['content', 'format'])
  })
})
