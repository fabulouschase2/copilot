import { describe, expect, it } from 'vitest'
import { RankableItem, rank, renderContextBlock, estimateTokens } from '../src/main/services/context/ranking'

function item(partial: Partial<RankableItem> & { itemId: string; text: string }): RankableItem {
  const now = 1_700_000_000_000
  return {
    sourceId: `src-${partial.itemId}`,
    type: 'document',
    displayName: `Doc ${partial.itemId}`,
    updatedAt: now - 60_000,
    ...partial
  } as RankableItem
}

describe('rank() — relevance, determinism, budgets', () => {
  it('ranks the most on-topic document first', () => {
    const docs = [
      item({ itemId: 'a', text: 'The quarterly report covers revenue and hiring plans for next year.' }),
      item({ itemId: 'b', text: 'Rust async runtimes: tokio task scheduling and work stealing.' }),
      item({ itemId: 'c', text: 'Hiring plan: three backend engineers, one designer, budget approved.' })
    ]
    const out = rank('hiring plan backend engineers', docs)
    expect(out[0].itemId).toBe('c')
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].reason).toContain('hiring')
    expect(out[0].reason).toContain('source=')
  })

  it('is deterministic across runs (identical output)', () => {
    const docs = [
      item({ itemId: 'x', text: 'deploy runbook: steps to ship the API safely' }),
      item({ itemId: 'y', text: 'deploy checklist and rollback notes for the API' })
    ]
    const r1 = rank('deploy the api', docs)
    const r2 = rank('deploy the api', docs)
    expect(r1.map((r) => r.itemId)).toEqual(r2.map((r) => r.itemId))
    expect(r1.map((r) => r.score)).toEqual(r2.map((r) => r.score))
  })

  it('breaks score ties deterministically (sourceId order)', () => {
    const docs = [
      item({ itemId: 'b', text: 'identical content alpha' }),
      item({ itemId: 'a', text: 'identical content alpha' })
    ]
    const out = rank('alpha', docs, { recencyWindowMs: 0 })
    expect(out.map((r) => r.sourceId)).toEqual([...out.map((r) => r.sourceId)].sort())
  })

  it('near-duplicate content is suppressed to a single item', () => {
    const docs = [
      item({ itemId: 'orig', text: 'Rust ownership prevents data races at compile time.' }),
      item({ itemId: 'dup', text: 'rust  ownership  prevents data races at compile time.' })
    ]
    const out = rank('rust ownership', docs)
    expect(out).toHaveLength(1)
  })

  it('enforces per-item and total character budgets', () => {
    const docs = [item({ itemId: 'big', text: 'budget '.repeat(500) })]
    const out = rank('budget', docs, { perItemCharBudget: 100 })
    expect(out[0].text.length).toBeLessThanOrEqual(101)
    expect(out[0].text.endsWith('…')).toBe(true)

    const many = Array.from({ length: 20 }, (_, i) =>
      item({ itemId: `d${i}`, text: `budget item ${i} `.repeat(200) })
    )
    const bounded = rank('budget item', many, { perItemCharBudget: 300, maxTotalChars: 1_000 })
    const totalChars = bounded.reduce((s, r) => s + r.text.length, 0)
    expect(totalChars).toBeLessThanOrEqual(1_000 + bounded.length) // truncation marker slack
  })

  it('irrelevant candidates are not included (minScore)', () => {
    const docs = [item({ itemId: 'a', text: 'gardening tips for tomatoes and peppers' })]
    expect(rank('quantum computing latency', docs)).toHaveLength(0)
  })

  it('empty query or empty corpus yields nothing', () => {
    expect(rank('', [item({ itemId: 'a', text: 'anything' })])).toHaveLength(0)
    expect(rank('anything', [])).toHaveLength(0)
  })

  it('respects maxItems', () => {
    const docs = Array.from({ length: 8 }, (_, i) => item({ itemId: `m${i}`, text: `meeting notes ${i}` }))
    expect(rank('meeting notes', docs, { maxItems: 3 })).toHaveLength(3)
  })

  it('profile sources get a type prior over equivalent documents', () => {
    const doc = item({ itemId: 'doc', type: 'document', text: 'prefers concise answers' })
    const fact = item({ itemId: 'fact', type: 'profile', text: 'prefers concise answers', updatedAt: Date.now() - 3_600_000 })
    const out = rank('prefers concise answers', [doc, fact])
    expect(out[0].type).toBe('profile')
  })
})

describe('attribution rendering', () => {
  it('renders an attributed context block with source names', () => {
    const block = renderContextBlock([
      {
        itemId: 'i1',
        sourceId: 's1',
        type: 'document',
        displayName: 'resume.md',
        text: 'Six years of TypeScript.',
        updatedAt: 0,
        rawScore: 1,
        score: 1,
        reason: 'test',
        matchedTerms: ['typescript']
      }
    ])
    expect(block).toContain('resume.md')
    expect(block).toContain('Six years of TypeScript.')
    expect(block).toContain('traceable')
  })

  it('estimateTokens is monotonic', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})
