import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/services/settings-store'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'settings-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const provider = {
  id: 'p1',
  label: 'Local Ollama',
  kind: 'openai-compatible' as const,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1',
  enabled: true,
  vision: false
}

describe('SettingsStore', () => {
  it('returns validated defaults when the file is missing', () => {
    const store = new SettingsStore(path.join(tempDir(), 'settings.json'))
    expect(store.get().providers).toEqual([])
    expect(store.get().theme).toBe('dark')
    expect(store.get().responseMode).toBe('concise')
  })

  it('roundtrips settings and fills schema defaults', () => {
    const file = path.join(tempDir(), 'settings.json')
    const store = new SettingsStore(file)
    store.set({ ...store.get(), providers: [provider], activeProviderId: 'p1' })
    const reloaded = new SettingsStore(file)
    expect(reloaded.get().providers).toEqual([provider])
    expect(reloaded.get().activeProviderId).toBe('p1')
  })

  it('falls back to defaults on a corrupt file instead of crashing', () => {
    const file = path.join(tempDir(), 'settings.json')
    writeFileSync(file, '{ not json', 'utf-8')
    const store = new SettingsStore(file)
    expect(store.get().theme).toBe('dark')
  })

  it('rejects invalid provider rows (bad baseUrl scheme)', () => {
    const store = new SettingsStore(path.join(tempDir(), 'settings.json'))
    expect(() =>
      store.set({ ...store.get(), providers: [{ ...provider, baseUrl: 'ftp://x' }] })
    ).toThrow()
  })

  it('applies defaults for fields omitted in a hand-edited file', () => {
    const file = path.join(tempDir(), 'settings.json')
    writeFileSync(file, JSON.stringify({ providers: [provider] }), 'utf-8')
    const store = new SettingsStore(file)
    expect(store.get().responseMode).toBe('concise')
    expect(store.get().activeProviderId).toBeNull()
  })
})
