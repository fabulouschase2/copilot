import { describe, expect, it } from 'vitest'
import {
  ScreenArmRequestSchema,
  ScreenCaptureRequestSchema,
  ScreenRegionSchema,
  ScreenSourcesRequestSchema
} from '../src/shared/protocol'

describe('Stage 6 IPC boundary validation (security)', () => {
  it('accepts a valid capture request and applies defaults', () => {
    const parsed = ScreenCaptureRequestSchema.parse({
      kind: 'screen',
      question: 'What is on screen?'
    })
    expect(parsed.includeTranscript).toBe(false)
    expect(parsed.includeContext).toBe(true)
    expect(parsed.region).toBeUndefined()
  })

  it('rejects malformed questions, kinds, and source ids', () => {
    expect(() => ScreenCaptureRequestSchema.parse({ kind: 'screen', question: '' })).toThrow()
    expect(() =>
      ScreenCaptureRequestSchema.parse({ kind: 'screen', question: 'x'.repeat(4_001) })
    ).toThrow()
    expect(() => ScreenCaptureRequestSchema.parse({ kind: 'camera', question: 'q' })).toThrow()
    expect(() => ScreenCaptureRequestSchema.parse({ kind: 'screen', question: 'q', sourceId: 'a'.repeat(257) })).toThrow()
  })

  it('rejects out-of-range region coordinates', () => {
    expect(() => ScreenRegionSchema.parse({ x: -0.1, y: 0, w: 0.5, h: 0.5 })).toThrow()
    expect(() => ScreenRegionSchema.parse({ x: 0, y: 0, w: 1.1, h: 0.5 })).toThrow()
    expect(() => ScreenRegionSchema.parse({ x: 0, y: 0, w: 'wide', h: 0.5 })).toThrow()
  })

  it('validates arm and source-list payloads', () => {
    expect(ScreenArmRequestSchema.parse({ enabled: true }).enabled).toBe(true)
    expect(() => ScreenArmRequestSchema.parse({ enabled: 'yes' })).toThrow()
    expect(ScreenSourcesRequestSchema.parse({ kind: 'window' }).kind).toBe('window')
    expect(() => ScreenSourcesRequestSchema.parse({ kind: 'printer' })).toThrow()
  })

  it('never accepts file paths — there is no filesystem field in any Stage 6 schema', () => {
    // Renderer-controlled file reads are impossible by contract: capture
    // payloads carry no path field at all. This test pins that contract.
    const keys = new Set(
      ScreenCaptureRequestSchema.keyof().options.map(String) as string[]
    )
    expect(keys.has('path')).toBe(false)
    expect(keys.has('filePath')).toBe(false)
    expect(keys.has('image')).toBe(false) // images flow main→renderer only
  })
})
