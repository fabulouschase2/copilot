import { describe, expect, it } from 'vitest'
import { detectQuestions } from '../src/main/services/modes/question-detection'

describe('question detection', () => {
  it('detects explicit question marks as high confidence', () => {
    const out = detectQuestions('How did you handle the migration?')
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('high')
  })

  it('detects interview openers without question marks as medium confidence', () => {
    const out = detectQuestions('Tell me about a time you had to deal with a difficult stakeholder.')
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe('medium')
    expect(out[0].kind).toBe('behavioral')
  })

  it('classifies behavioral vs technical vs general', () => {
    const behavioral = detectQuestions('Describe a situation where you showed leadership.')[0]
    expect(behavioral.kind).toBe('behavioral')
    const technical = detectQuestions('What is the time complexity of your algorithm?')[0]
    expect(technical.kind).toBe('technical')
    const general = detectQuestions('Where do you see yourself in five years?')[0]
    expect(general.kind).toBe('general')
  })

  it('does NOT treat every sentence as a question (false-positive handling)', () => {
    expect(detectQuestions("I don't know what to do next.")).toHaveLength(0)
    expect(detectQuestions("Here's what happened in the meeting.")).toHaveLength(0)
    expect(detectQuestions('That is what we decided.')).toHaveLength(0)
    expect(detectQuestions('We shipped the API on Friday. The team celebrated.')).toHaveLength(0)
    expect(detectQuestions('what')).toHaveLength(0) // too short, no substance
    expect(detectQuestions('Tell me.')).toHaveLength(0) // opener without substance
    expect(detectQuestions('')).toHaveLength(0)
  })

  it('mid-sentence question words do not trigger detection', () => {
    expect(detectQuestions('The team asked what to do, and we decided quickly.')).toHaveLength(0)
  })

  it('extracts multiple questions in order from one segment', () => {
    const out = detectQuestions('First, why did you choose Rust? Then tell me about a time you failed.')
    expect(out.map((q) => q.confidence)).toEqual(['high', 'medium'])
    expect(out[0].text).toContain('Rust?')
  })

  it('is deterministic', () => {
    const t = 'How would you design a rate limiter? And why does caching matter?'
    expect(detectQuestions(t)).toEqual(detectQuestions(t))
  })
})
