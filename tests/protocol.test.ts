import { describe, expect, it } from 'vitest'
import {
  AppSettingsSchema,
  ChatSendRequestSchema,
  CredentialSetRequestSchema,
  ProviderConfigSchema
} from '../src/shared/protocol'

describe('IPC payload schemas (input validation boundary)', () => {
  it('accepts a valid chat request and applies mode default', () => {
    const parsed = ChatSendRequestSchema.parse({
      requestId: 'r-1',
      messages: [{ role: 'user', content: 'hello' }]
    })
    expect(parsed.mode).toBe('concise')
  })

  it('rejects oversized and malformed chat requests', () => {
    expect(() =>
      ChatSendRequestSchema.parse({ requestId: 'r-1', messages: [{ role: 'user', content: 'x'.repeat(200_001) }] })
    ).toThrow()
    expect(() =>
      ChatSendRequestSchema.parse({ requestId: 'r-1', messages: [{ role: 'hacker', content: 'x' }] })
    ).toThrow()
    expect(() =>
      ChatSendRequestSchema.parse({ requestId: '', messages: [{ role: 'user', content: 'x' }] })
    ).toThrow()
    expect(() => ChatSendRequestSchema.parse({ requestId: 'r-1', messages: [] })).toThrow()
  })

  it('rejects non-http provider base URLs and bad model names', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        id: 'p',
        label: 'x',
        kind: 'openai-compatible',
        baseUrl: 'file:///etc/passwd',
        model: 'm',
        enabled: true
      })
    ).toThrow()
  })

  it('fills provider/settings defaults (vision=false, theme=dark)', () => {
    const provider = ProviderConfigSchema.parse({
      id: 'p',
      label: 'x',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      enabled: true
    })
    expect(provider.vision).toBe(false)
    const settings = AppSettingsSchema.parse({})
    expect(settings.theme).toBe('dark')
    expect(settings.providers).toEqual([])
    expect(settings.activeProviderId).toBeNull()
  })

  it('rejects credential payloads that are too large or empty', () => {
    expect(() => CredentialSetRequestSchema.parse({ providerId: 'p', secret: '' })).toThrow()
    expect(() => CredentialSetRequestSchema.parse({ providerId: 'p', secret: 'x'.repeat(4097) })).toThrow()
    expect(() => CredentialSetRequestSchema.parse({ providerId: '', secret: 'x' })).toThrow()
  })
})
