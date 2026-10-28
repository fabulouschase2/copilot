import { describe, expect, it } from 'vitest'
import { ContextEngine, ContextItem, estimateTokens } from '../src/main/services/context-engine'

function item(partial: Partial<ContextItem> & { id: string; text: string }): ContextItem {
  return { kind: 'transcript', timestamp: Date.now(), ...partial }
}

describe('ContextEngine', () => {
  it('deduplicates normalized text by refreshing instead of duplicating', () => {
    const engine = new ContextEngine()
    engine.add(item({ id: '1', text: 'Deploy the API tomorrow' }))
    engine.add(item({ id: '2', text: '  deploy   the API   tomorrow ' }))
    expect(engine.snapshot()).toHaveLength(1)
  })

  it('evicts oldest non-pinned items beyond maxItems but keeps pinned', () => {
    const engine = new ContextEngine({ maxItems: 3 })
    engine.add(item({ id: '1', text: 'one' }))
    engine.add(item({ id: '2', text: 'two', pinned: true }))
    engine.add(item({ id: '3', text: 'three' }))
    engine.add(item({ id: '4', text: 'four' }))
    const texts = engine.snapshot().map((i) => i.text)
    expect(texts).toContain('two')
    expect(texts).not.toContain('one')
    expect(engine.snapshot()).toHaveLength(3)
  })

  it('drops items older than maxAgeMs unless pinned', () => {
    const engine = new ContextEngine({ maxAgeMs: 1000 })
    engine.add(item({ id: 'old', text: 'stale', timestamp: Date.now() - 60_000 }))
    engine.add(item({ id: 'fresh', text: 'fresh' }))
    engine.add(item({ id: 'pin', text: 'pinned old', timestamp: Date.now() - 60_000, pinned: true }))
    const texts = engine.snapshot().map((i) => i.text)
    expect(texts).toContain('fresh')
    expect(texts).toContain('pinned old')
    expect(texts).not.toContain('stale')
  })

  it('builds a budgeted window newest-first, returned chronologically', () => {
    const engine = new ContextEngine()
    const base = Date.now() - 3_000
    engine.add(item({ id: 'a', text: 'a'.repeat(400), timestamp: base }))
    engine.add(item({ id: 'b', text: 'b'.repeat(400), timestamp: base + 1 }))
    engine.add(item({ id: 'c', text: 'c'.repeat(400), timestamp: base + 2 }))
    // budget fits only ~2 items of 100 estimated tokens each
    const built = engine.build(250)
    expect(built.map((i) => i.id)).toEqual(['b', 'c'])
  })

  it('always includes pinned items even when the budget is tiny', () => {
    const engine = new ContextEngine()
    engine.add(item({ id: 'a', text: 'a'.repeat(4000) }))
    engine.add(item({ id: 'p', text: 'resume: 8 years Rust', pinned: true }))
    const built = engine.build(10)
    expect(built.map((i) => i.id)).toEqual(['p'])
  })

  it('renders labeled context blocks', () => {
    const engine = new ContextEngine()
    engine.add(item({ id: '1', text: 'Q3 revenue is up', kind: 'note' }))
    const rendered = engine.render()
    expect(rendered).toBe('[note] Q3 revenue is up')
  })

  it('clear() and remove() work', () => {
    const engine = new ContextEngine()
    engine.add(item({ id: '1', text: 'x' }))
    engine.add(item({ id: '2', text: 'y' }))
    engine.remove('1')
    expect(engine.snapshot().map((i) => i.id)).toEqual(['2'])
    engine.clear()
    expect(engine.snapshot()).toHaveLength(0)
    expect(engine.render()).toBe('')
  })

  it('estimateTokens is monotonic and roughly length/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })
})
