import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, SafeStorageLike } from '../src/main/services/credential-store'

function fakeSafeStorage(prefix = 'enc:'): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(prefix + Buffer.from(s, 'utf-8').toString('base64')),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf-8').slice(prefix.length), 'base64').toString('utf-8')
  }
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'creds-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('CredentialStore', () => {
  it('roundtrips a secret through safeStorage encryption', () => {
    const dir = tempDir()
    const file = path.join(dir, 'credentials.json')
    const store = new CredentialStore(file, fakeSafeStorage())
    store.set('openai', 'sk-secret-123')
    expect(store.get('openai')).toBe('sk-secret-123')
    expect(store.has('openai')).toBe(true)
    expect(store.list()).toEqual(['openai'])
    // on-disk bytes must not contain the plaintext
    const raw = readFileSync(file, 'utf-8')
    expect(raw).not.toContain('sk-secret-123')
  })

  it('persists across instances', () => {
    const dir = tempDir()
    const file = path.join(dir, 'credentials.json')
    new CredentialStore(file, fakeSafeStorage()).set('p1', 'alpha')
    expect(new CredentialStore(file, fakeSafeStorage()).get('p1')).toBe('alpha')
  })

  it('refuses plaintext when OS encryption is unavailable (no silent fallback)', () => {
    const dir = tempDir()
    const store = new CredentialStore(path.join(dir, 'credentials.json'), null)
    expect(() => store.set('p1', 'sk-x')).toThrow(/refusing to store/)
    expect(store.has('p1')).toBe(false)
  })

  it('allowPlaintextFallback=true stores in the clear, visibly', () => {
    const dir = tempDir()
    const store = new CredentialStore(path.join(dir, 'credentials.json'), null, true)
    store.set('p1', 'sk-x')
    expect(store.get('p1')).toBe('sk-x')
  })

  it('returns null for encrypted entries when decryption is later unavailable', () => {
    const dir = tempDir()
    const file = path.join(dir, 'credentials.json')
    new CredentialStore(file, fakeSafeStorage()).set('p1', 'secret')
    const locked = new CredentialStore(file, {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString('utf-8')
    })
    expect(locked.get('p1')).toBeNull()
  })

  it('remove() deletes the entry and set("") clears it', () => {
    const dir = tempDir()
    const store = new CredentialStore(path.join(dir, 'credentials.json'), fakeSafeStorage())
    store.set('p1', 'a')
    store.set('p2', 'b')
    store.set('p1', '')
    expect(store.list()).toEqual(['p2'])
    store.remove('p2')
    expect(store.list()).toEqual([])
  })

  it('tolerates a corrupt file by starting empty', () => {
    const dir = tempDir()
    const file = path.join(dir, 'credentials.json')
    new CredentialStore(file, fakeSafeStorage()).set('p1', 'a')
    // simulate corruption by a second store reading a truncated file
    writeFileSync(file, '{"version":1,"entries":{"p1":{"enc":tr', 'utf-8')
    const store = new CredentialStore(file, fakeSafeStorage())
    expect(store.get('p1')).toBeNull()
    expect(store.has('p1')).toBe(false)
  })
})
