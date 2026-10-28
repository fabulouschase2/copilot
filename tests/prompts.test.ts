import { describe, expect, it } from 'vitest'
import {
  FABRICATION_PROHIBITION,
  interviewSystemPrompt,
  meetingActionsPrompt,
  meetingAskPrompt,
  meetingSummaryPrompt,
  renderModeContextBlock
} from '../src/main/services/modes/prompts'

describe('interview prompt contract', () => {
  it('every style carries the fabrication prohibition', () => {
    for (const style of ['concise', 'detailed', 'technical', 'star'] as const) {
      const p = interviewSystemPrompt(style, 'good')
      expect(p).toContain(FABRICATION_PROHIBITION.slice(0, 60))
      expect(p).toMatch(/never invent/i)
      expect(p).toMatch(/Missing details/i)
    }
  })

  it('STAR style requires labeled sections and a template fallback', () => {
    const p = interviewSystemPrompt('star', 'none')
    expect(p).toContain('"Situation:"')
    expect(p).toContain('"Task:"')
    expect(p).toContain('"Action:"')
    expect(p).toContain('"Result:"')
    expect(p).toContain('[General STAR template]')
  })

  it('evidence level shapes the guidance honestly', () => {
    expect(interviewSystemPrompt('concise', 'none')).toMatch(/no supporting evidence/i)
    expect(interviewSystemPrompt('concise', 'partial')).toMatch(/limited/i)
    expect(interviewSystemPrompt('concise', 'good')).toMatch(/ground the answer/i)
  })

  it('never references speaking or typing answers elsewhere', () => {
    const p = interviewSystemPrompt('detailed', 'good')
    expect(p.toLowerCase()).not.toContain('speak')
    expect(p.toLowerCase()).not.toContain('type into')
  })
})

describe('meeting prompt contract', () => {
  it('summary prompt demands evidence-only owners/deadlines', () => {
    const p = meetingSummaryPrompt()
    expect(p).toContain('(not stated)')
    expect(p).toContain('Never guess owners or dates')
    expect(p).toContain('## Decisions')
    expect(p).toContain('## Action items')
    expect(p).toContain('Uncertain / needs follow-up')
  })

  it('actions prompt separates confirmed from suggested items', () => {
    const p = meetingActionsPrompt()
    expect(p).toContain('[suggested]')
    expect(p).toContain('Suggested follow-ups')
    expect(p).toContain('(not stated)')
  })

  it('ask prompt restricts answers to the transcript', () => {
    const p = meetingAskPrompt()
    expect(p).toMatch(/ONLY the provided transcript/i)
    expect(p).toContain('Interpretation:')
  })
})

describe('context rendering for modes', () => {
  it('renders attributed items and handles the empty case', () => {
    const block = renderModeContextBlock([
      { type: 'profile', displayName: 'Profile: skill', text: 'Six years of TypeScript' }
    ])
    expect(block).toContain('[profile]')
    expect(block).toContain('Six years of TypeScript')
    expect(renderModeContextBlock([])).toMatch(/No supporting context/i)
  })
})
