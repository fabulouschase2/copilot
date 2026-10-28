/**
 * Durable application settings (Module I), stored as JSON in the user-data
 * directory and validated against the shared schema on every load so a
 * corrupt or hand-edited file can never crash the app.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { AppSettings, AppSettingsSchema, DEFAULT_SETTINGS } from '../../shared/protocol'

export class SettingsStore {
  private cached: AppSettings

  constructor(private filePath: string) {
    this.cached = this.load()
  }

  static forUserData(userDataDir: string): SettingsStore {
    return new SettingsStore(path.join(userDataDir, 'settings.json'))
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown
      const parsed = AppSettingsSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      console.warn('[settings] invalid settings file; using defaults')
    } catch {
      /* missing file: defaults */
    }
    return DEFAULT_SETTINGS
  }

  get(): AppSettings {
    return this.cached
  }

  set(next: AppSettings): AppSettings {
    const parsed = AppSettingsSchema.parse(next)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(parsed, null, 2), 'utf-8')
    this.cached = parsed
    return this.cached
  }
}
