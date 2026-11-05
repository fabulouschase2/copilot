import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveCredential } from '../src/shared/credentials'
import { SegmentStt } from '../src/main/services/stt/segment-stt'
import { DeepgramStt } from '../src/main/services/stt/deepgram-stt'
import { CredentialStore, SafeStorageLike } from '../src/main/services/credential-store'
import { SettingsStore } from '../src/main/services/settings-store'
import { SttRegistry } from '../src/main/services/stt/stt-registry'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

/**
 * API-key management tests (v0.2.3): successful saves, failed saves, empty
 * keys, and connection testing for transcription providers. Secrets are
 * fakes — never real keys — and never printed.
 */

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('credential save helper (renderer)', () => {
  const fakeSet = vi.fn<(id: string, secret: string) => Promise<{ ok: boolean; message?: string }>>()

  it('saves successfully and reports Saved', async () => {
    fakeSet.mockResolvedValueOnce({ ok: true })
    const res = await saveCredential('prov-1', '  sk-live-abc  ', fakeSet)
    expect(res.ok).toBe(true)
    expect(res.message).toBe('Saved')
    expect(fakeSet).toHaveBeenCalledWith('prov-1', 'sk-live-abc') // trimmed secret
  })

  it('surfaces a failed save without throwing', async () => {
    fakeSet.mockResolvedValueOnce({ ok: false, message: 'credential store refused the key' })
    const res = await saveCredential('prov-1', 'sk-live-abc', fakeSet)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Save failed')
    expect(res.message).toContain('refused')
  })

  it('rejects an empty key BEFORE calling the credential store', async () => {
    fakeSet.mockClear()
    const res = await saveCredential('prov-1', '', fakeSet)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Enter a key')
    expect(fakeSet).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only key the same way', async () => {
    fakeSet.mockClear()
    const res = await saveCredential('prov-1', '   ', fakeSet)
    expect(res.ok).toBe(false)
    expect(fakeSet).not.toHaveBeenCalled()
  })

  it('surfaces an unexpected IPC failure without leaking the secret', async () => {
    fakeSet.mockRejectedValueOnce(new Error('IPC gone'))
    const res = await saveCredential('prov-1', 'sk-live-abc', fakeSet)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('IPC gone')
    expect(res.message).not.toContain('sk-live-abc')
  })
})

describe('transcription provider connection testing', () => {
  it('SegmentStt.testConnection reports success with latency', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const stt = new SegmentStt(
      { id: 's1', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: 'whisper-large-v3' },
      fetchImpl as unknown as typeof fetch
    )
    const res = await stt.testConnection()
    expect(res.ok).toBe(true)
    expect(res.message).toBe('Connected')
    expect(res.latencyMs).not.toBeNull()
  })

  it('SegmentStt.testConnection reports authentication failures clearly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const stt = new SegmentStt(
      { id: 's1', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'bad', model: 'whisper-large-v3' },
      fetchImpl as unknown as typeof fetch
    )
    const res = await stt.testConnection()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Authentication failed')
  })

  it('SegmentStt.testConnection reports unreachable providers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const stt = new SegmentStt(
      { id: 's1', label: 'Local', baseUrl: 'http://localhost:9/v1', apiKey: '', model: 'whisper' },
      fetchImpl as unknown as typeof fetch
    )
    const res = await stt.testConnection()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Could not reach provider')
    expect(res.latencyMs).toBeNull()
  })

  it('DeepgramStt.testConnection works against the projects endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    )
    const stt = new DeepgramStt({
      id: 'd1',
      label: 'Deepgram',
      baseUrl: 'https://api.deepgram.com',
      apiKey: 'k',
      model: 'nova-2',
      language: 'en'
    })
    const res = await stt.testConnection()
    expect(res.ok).toBe(true)
    expect(res.message).toBe('Connected')
  })

  it('DeepgramStt.testConnection reports auth failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 })
    )
    const stt = new DeepgramStt({
      id: 'd1',
      label: 'Deepgram',
      baseUrl: 'https://api.deepgram.com',
      apiKey: 'bad',
      model: 'nova-2',
      language: 'en'
    })
    const res = await stt.testConnection()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Authentication failed')
  })
})

describe('SttRegistry: credential visibility + per-provider test resolution', () => {
  function makeRegistry(rows: Array<Record<string, unknown>>): { registry: SttRegistry; creds: CredentialStore } {
    const dir = mkdtempSync(path.join(tmpdir(), 'sttreg2-'))
    dirs.push(dir)
    const settingsFile = path.join(dir, 'settings.json')
    writeFileSync(
      settingsFile,
      JSON.stringify({
        providers: [],
        stt: { providers: rows, activeSttProviderId: null, vadThresholdDb: -45, maxSegmentMs: 20000 }
      })
    )
    const settings = new SettingsStore(settingsFile)
    const creds = new CredentialStore(path.join(dir, 'credentials.json'), fakeSafeStorageLocal())
    return { registry: new SttRegistry(settings, creds), creds }
  }

  function fakeSafeStorageLocal(): SafeStorageLike {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf-8').toString('base64')),
      decryptString: (b: Buffer) => Buffer.from(b.toString('utf-8').slice(4), 'base64').toString('utf-8')
    }
  }

  const GROQ = {
    id: 's-groq',
    label: 'Groq',
    kind: 'stt-segment',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    language: 'en',
    enabled: true
  }
  const DEEPGRAM = {
    id: 's-dg',
    label: 'Deepgram',
    kind: 'stt-stream',
    baseUrl: 'https://api.deepgram.com',
    model: 'nova-2',
    language: 'en',
    enabled: true
  }

  it('listProviders exposes hasCredential without secrets', () => {
    const { registry, creds } = makeRegistry([GROQ, DEEPGRAM])
    creds.set('s-groq', 'gsk-fake')
    const list = registry.listProviders()
    const groq = list.find((p) => p.id === 's-groq')!
    const dg = list.find((p) => p.id === 's-dg')!
    expect(groq.hasCredential).toBe(true)
    expect(dg.hasCredential).toBe(false)
    expect(groq.model).toBe('whisper-large-v3')
    expect(groq.language).toBe('en')
    // no secret anywhere in the exposed metadata
    expect(JSON.stringify(list)).not.toContain('gsk-fake')
  })

  it('resolveById builds the right adapter per kind and null for unknown ids', () => {
    const { registry } = makeRegistry([GROQ, DEEPGRAM])
    const seg = registry.resolveById('s-groq')
    expect(seg?.adapter.kind).toBe('stt-segment')
    const stream = registry.resolveById('s-dg')
    expect(stream?.adapter.kind).toBe('stt-stream')
    expect(registry.resolveById('nope')).toBeNull()
  })
})
