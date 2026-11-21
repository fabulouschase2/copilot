/**
 * 0.4.0 provider routing: modes, privacy and capability rules.
 *
 * These tests pin the privacy promise: private material (screen, meetings,
 * career) never reaches a cloud provider unless the user explicitly allows it,
 * and `local` mode never considers a cloud provider at all.
 */
import { describe, expect, it } from 'vitest'
import { AppSettingsSchema } from '../src/shared/protocol'
import { ProviderRegistry, isLocalProvider } from '../src/main/services/provider-registry'
import type { SettingsStore } from '../src/main/services/settings-store'
import type { CredentialStore } from '../src/main/services/credential-store'
import type { AppSettings, ProviderConfig } from '../src/shared/protocol'

const CLOUD: ProviderConfig = {
  id: 'gemini',
  label: 'Google Gemini',
  kind: 'openai-compatible',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  model: 'gemini-2.0-flash',
  enabled: true,
  vision: true
}

const LOCAL: ProviderConfig = {
  id: 'ollama',
  label: 'Ollama',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:1.5b',
  enabled: true,
  vision: false
}

function registryFor(overrides: Partial<AppSettings>, credentialIds: string[] = []): ProviderRegistry {
  const settings = AppSettingsSchema.parse(overrides)
  const creds = {
    has: (id: string) => credentialIds.includes(id),
    get: (id: string) => (credentialIds.includes(id) ? `key-${id}` : null)
  } as unknown as CredentialStore
  return new ProviderRegistry({ get: () => settings } as unknown as SettingsStore, creds)
}

describe('local detection', () => {
  it('treats loopback endpoints as local and everything else as cloud', () => {
    expect(isLocalProvider(LOCAL)).toBe(true)
    expect(isLocalProvider(CLOUD)).toBe(false)
    expect(isLocalProvider({ ...LOCAL, baseUrl: 'http://localhost:11434/v1' })).toBe(true)
    expect(isLocalProvider({ ...LOCAL, baseUrl: 'http://[::1]:11434/v1' })).toBe(true)
    expect(isLocalProvider({ ...LOCAL, baseUrl: 'not a url' })).toBe(false)
  })
})

describe('modes', () => {
  it('local mode never returns a cloud provider', () => {
    const plan = registryFor(
      { aiMode: 'local', providers: [CLOUD, LOCAL], activeProviderId: 'gemini' },
      ['gemini']
    ).plan({ kind: 'chat' })
    expect(plan.routes.map((r) => r.id)).toEqual(['ollama'])
    expect(registryFor({ aiMode: 'local', providers: [CLOUD] }, ['gemini']).plan({ kind: 'chat' }).routes).toEqual([])
    expect(registryFor({ aiMode: 'local', providers: [CLOUD] }, ['gemini']).plan().cloudBlockedReason).toBe('mode-local')
  })

  it('cloud mode never returns a local provider', () => {
    const plan = registryFor({ aiMode: 'cloud', providers: [CLOUD, LOCAL] }).plan({ kind: 'chat' })
    expect(plan.routes.map((r) => r.id)).toEqual(['gemini'])
  })

  it('hybrid prefers local, then cloud, respecting the active choice inside a tier', () => {
    const plan = registryFor({
      aiMode: 'hybrid',
      providers: [CLOUD, LOCAL],
      activeProviderId: 'gemini'
    }).plan({ kind: 'chat' })
    expect(plan.routes.map((r) => r.id)).toEqual(['ollama', 'gemini'])
    expect(plan.routes.map((r) => r.kind)).toEqual(['local', 'cloud'])
  })

  it('resolveActive follows the mode', () => {
    expect(registryFor({ aiMode: 'local', providers: [CLOUD] }).resolveActive()).toBeNull()
    expect(registryFor({ aiMode: 'cloud', providers: [LOCAL] }).resolveActive()).toBeNull()
    expect(registryFor({ aiMode: 'hybrid', providers: [LOCAL] }).resolveActive()?.model).toBe('qwen2.5:1.5b')
  })

  it('ignores disabled providers', () => {
    const disabled = { ...LOCAL, enabled: false }
    expect(registryFor({ providers: [disabled, CLOUD] }).plan().routes.map((r) => r.id)).toEqual(['gemini'])
  })
})

describe('privacy', () => {
  it('blocks cloud for private tasks by default', () => {
    const plan = registryFor({ providers: [LOCAL, CLOUD] }).plan({ kind: 'chat', sensitivity: 'private' })
    expect(plan.routes.map((r) => r.id)).toEqual(['ollama'])
    expect(plan.cloudBlockedReason).toBe('privacy')
  })

  it('allows cloud for private tasks only after explicit permission', () => {
    const plan = registryFor({ providers: [LOCAL, CLOUD], allowCloudPrivate: true }).plan({
      kind: 'chat',
      sensitivity: 'private'
    })
    expect(plan.routes.map((r) => r.id)).toEqual(['ollama', 'gemini'])
    expect(plan.cloudBlockedReason).toBeNull()
  })

  it('normal tasks may use cloud in hybrid mode', () => {
    const plan = registryFor({ providers: [LOCAL, CLOUD] }).plan({ kind: 'chat', sensitivity: 'normal' })
    expect(plan.routes.map((r) => r.id)).toContain('gemini')
  })

  it('vision resolution excludes cloud when private material is not permitted', () => {
    const withVision = registryFor({ providers: [LOCAL, CLOUD] })
    expect(withVision.resolveVision()).toBeNull()
    const allowed = registryFor({ providers: [LOCAL, CLOUD], allowCloudPrivate: true })
    expect(allowed.resolveVision()?.label).toBe('Google Gemini')
  })
})

describe('capability', () => {
  it('vision tasks only consider providers marked as accepting images', () => {
    const blindCloud = { ...CLOUD, vision: false }
    const plan = registryFor({ providers: [blindCloud, LOCAL] }).plan({ kind: 'vision' })
    expect(plan.routes).toEqual([])
  })

  it('chat tasks consider every enabled provider', () => {
    const plan = registryFor({ providers: [CLOUD, LOCAL] }).plan({ kind: 'chat' })
    expect(plan.routes).toHaveLength(2)
  })
})

describe('settings contract', () => {
  it('defaults to hybrid with cloud-private disabled', () => {
    const settings = AppSettingsSchema.parse({})
    expect(settings.aiMode).toBe('hybrid')
    expect(settings.allowCloudPrivate).toBe(false)
  })

  it('rejects unknown modes', () => {
    expect(AppSettingsSchema.safeParse({ aiMode: 'turbo' }).success).toBe(false)
  })
})
