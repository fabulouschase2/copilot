/**
 * Credential storage for provider API keys (Module J).
 *
 * Keys are encrypted with Electron's safeStorage (DPAPI on Windows, Keychain
 * on macOS, libsecret on Linux) and stored as ciphertext in a JSON file under
 * the user-data directory. Plaintext is only ever held in the main process;
 * the renderer references providers by id and never receives key material.
 *
 * If OS-level encryption is unavailable the store refuses to keep secrets in
 * plaintext by default; callers must opt in explicitly. This keeps an
 * accidental misconfiguration from silently writing keys to disk in the clear.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface CredentialFile {
  version: 1
  /** providerId -> { enc: true, data: base64 } | { enc: false, data: plaintext } */
  entries: Record<string, { enc: boolean; data: string }>
}

export class CredentialStore {
  private cache: CredentialFile = { version: 1, entries: {} }

  constructor(
    private filePath: string,
    private safeStorage: SafeStorageLike | null,
    private allowPlaintextFallback = false
  ) {
    this.load()
  }

  static forUserData(userDataDir: string, safeStorage: SafeStorageLike | null): CredentialStore {
    return new CredentialStore(path.join(userDataDir, 'credentials.json'), safeStorage)
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as CredentialFile
      if (parsed && parsed.version === 1 && typeof parsed.entries === 'object') {
        this.cache = parsed
      }
    } catch {
      /* missing or corrupt file: start empty (a corrupt file never blocks startup) */
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
  }

  set(providerId: string, secret: string): void {
    if (secret.length === 0) {
      this.remove(providerId)
      return
    }
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      const enc = this.safeStorage.encryptString(secret)
      this.cache.entries[providerId] = { enc: true, data: enc.toString('base64') }
    } else if (this.allowPlaintextFallback) {
      this.cache.entries[providerId] = { enc: false, data: secret }
    } else {
      throw new Error(
        'OS credential encryption is unavailable; refusing to store the API key. ' +
          'Enable plaintext fallback explicitly in Settings if you accept the risk.'
      )
    }
    this.persist()
  }

  get(providerId: string): string | null {
    const entry = this.cache.entries[providerId]
    if (!entry) return null
    if (entry.enc) {
      if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) return null
      try {
        return this.safeStorage.decryptString(Buffer.from(entry.data, 'base64'))
      } catch {
        return null
      }
    }
    return entry.data
  }

  has(providerId: string): boolean {
    return providerId in this.cache.entries
  }

  remove(providerId: string): void {
    delete this.cache.entries[providerId]
    this.persist()
  }

  list(): string[] {
    return Object.keys(this.cache.entries).sort()
  }
}
