import { describe, expect, it } from 'vitest'
import {
  ChatSendRequestSchema,
  ContextExclusionSchema,
  ContextOptionsSchema,
  ContextSettingsSchema,
  ProfileFactOpSchema,
  AppSettingsSchema
} from '../src/shared/protocol'

describe('Stage 7 IPC boundary validation (security)', () => {
  it('profile ops are strictly shaped; injection-sized payloads rejected', () => {
    expect(ProfileFactOpSchema.parse({ op: 'add', text: 'likes Rust', category: 'skill' }).op).toBe('add')
    expect(() => ProfileFactOpSchema.parse({ op: 'add', text: 'x'.repeat(2_001), category: 'skill' })).toThrow()
    expect(() => ProfileFactOpSchema.parse({ op: 'add', text: 'x' })).toThrow() // missing category
    expect(() => ProfileFactOpSchema.parse({ op: 'unknown-op' })).toThrow()
    expect(() => ProfileFactOpSchema.parse({ op: 'remove', factId: '' })).toThrow()
  })

  it('exclusions require either a source id or a type, both bounded', () => {
    expect(ContextExclusionSchema.parse({ sourceId: 'doc-1', excluded: true }).excluded).toBe(true)
    expect(ContextExclusionSchema.parse({ type: 'document', excluded: false }).excluded).toBe(false)
    expect(() => ContextExclusionSchema.parse({ excluded: true })).toThrow()
    expect(() => ContextExclusionSchema.parse({ sourceId: 'x'.repeat(65), excluded: true })).toThrow()
  })

  it('context settings are bounded', () => {
    const s = ContextSettingsSchema.parse({})
    expect(s.totalTokenBudget).toBe(1_200)
    expect(s.perSourceCharBudget).toBe(1_200)
    expect(s.minScore).toBe(0.05)
    expect(() => ContextSettingsSchema.parse({ totalTokenBudget: 100 })).toThrow()
    expect(() => ContextSettingsSchema.parse({ totalTokenBudget: 9_000 })).toThrow()
  })

  it('context options carry safe defaults and reject unknown values', () => {
    const o = ContextOptionsSchema.parse({})
    expect(o).toEqual({ includeDocuments: true, includeProfile: true, includeSession: true })
    expect(() => ContextOptionsSchema.parse({ includeSession: 'yes' })).toThrow()
  })

  it('app settings parse with the new context section (backward compatible migration)', () => {
    // An old Stage 5 settings file (no `context` key) must keep working.
    const migrated = AppSettingsSchema.parse({
      providers: [],
      activeProviderId: null,
      theme: 'dark',
      responseMode: 'concise'
    })
    expect(migrated.context.totalTokenBudget).toBe(1_200)
  })

  it('chat send schema still enforces its limits (regression guard)', () => {
    expect(() => ChatSendRequestSchema.parse({ requestId: 'r', messages: [] })).toThrow()
  })
})
