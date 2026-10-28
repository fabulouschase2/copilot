import { describe, expect, it } from 'vitest'
import {
  ChatSendRequestSchema,
  TranscriptAudioChunkSchema,
  TranscriptMuteRequestSchema,
  TranscriptPrepareRequestSchema,
  TranscriptSessionRequestSchema
} from '../src/shared/protocol'

describe('Stage 5 IPC boundary validation (security)', () => {
  it('accepts a realistic 100 ms audio chunk', () => {
    const b64 = Buffer.alloc(3200).toString('base64') // ~100 ms @16 kHz PCM16
    const parsed = TranscriptAudioChunkSchema.parse({ sessionId: 't-1', seq: 0, b64 })
    expect(parsed.sessionId).toBe('t-1')
  })

  it('rejects oversized audio payloads (buffer-bomb guard)', () => {
    const tooBig = Buffer.alloc(70_000).toString('base64') // > 64 KB decoded
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: 't-1', seq: 0, b64: tooBig })).toThrow()
  })

  it('rejects malformed session ids, sequences and payloads', () => {
    const b64 = Buffer.alloc(100).toString('base64')
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: '', seq: 0, b64 })).toThrow()
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: 't', seq: -1, b64 })).toThrow()
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: 't', seq: 1.5, b64 })).toThrow()
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: 't', seq: 0, b64: 'not base64!!' })).toThrow()
    expect(() => TranscriptAudioChunkSchema.parse({ sessionId: 't', seq: 0, b64: 42 })).toThrow()
  })

  it('rejects unknown sources and invalid control payloads', () => {
    expect(() => TranscriptPrepareRequestSchema.parse({ source: 'camera' })).toThrow()
    expect(() => TranscriptSessionRequestSchema.parse({ sessionId: '' })).toThrow()
    expect(() => TranscriptMuteRequestSchema.parse({ sessionId: 't', muted: 'yes' })).toThrow()
  })

  it('chat schemas still enforce their limits (regression guard)', () => {
    expect(() =>
      ChatSendRequestSchema.parse({ requestId: 'r', messages: [{ role: 'user', content: 'x'.repeat(200_001) }] })
    ).toThrow()
  })
})
