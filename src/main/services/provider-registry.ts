/**
 * Provider registry (Module I): the only place that knows how settings rows
 * become live provider adapters. Rebuilt from current settings on every
 * lookup so provider changes apply to the next request with no restart.
 */
import { AppSettings, ProviderConfig, ProviderInfo } from '../../shared/protocol'
import { CredentialStore } from './credential-store'
import { SettingsStore } from './settings-store'
import { OpenAICompatibleProvider } from './providers/openai-compatible'
import { AIProvider } from './providers/types'

export interface ResolvedProvider {
  provider: AIProvider
  model: string
}

export class ProviderRegistry {
  constructor(
    private settings: SettingsStore,
    private creds: CredentialStore
  ) {}

  list(): ProviderInfo[] {
    return this.settings.get().providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      enabled: p.enabled,
      vision: p.vision,
      hasCredential: this.creds.has(p.id),
      model: p.model,
      baseUrl: p.baseUrl
    }))
  }

  /** Build a live adapter for a settings row, injecting its stored key. */
  private build(cfg: ProviderConfig): OpenAICompatibleProvider {
    const apiKey = this.creds.get(cfg.id) ?? ''
    return new OpenAICompatibleProvider({
      id: cfg.id,
      label: cfg.label,
      baseUrl: cfg.baseUrl,
      apiKey,
      model: cfg.model,
      vision: cfg.vision
    })
  }

  /**
   * Resolve the provider that should serve the NEXT request. Falls back to
   * the first enabled provider when the configured active id is missing or
   * disabled, so a deleted provider can never wedge the app.
   */
  resolveActive(): ResolvedProvider | null {
    const s: AppSettings = this.settings.get()
    const candidates = s.providers.filter((p) => p.enabled)
    if (candidates.length === 0) return null
    const chosen =
      candidates.find((p) => p.id === s.activeProviderId) ?? candidates[0]
    return { provider: this.build(chosen), model: chosen.model }
  }

  resolveForTest(providerId: string): OpenAICompatibleProvider | null {
    const cfg = this.settings.get().providers.find((p) => p.id === providerId)
    return cfg ? this.build(cfg) : null
  }

  /**
   * Resolve a vision-capable provider for screen analysis (Stage 6):
   * the enabled provider marked "accepts images"; falls back to the first
   * enabled vision-capable row. Null when none qualifies.
   */
  resolveVision(): { provider: AIProvider; model: string; id: string; label: string } | null {
    const s: AppSettings = this.settings.get()
    const candidates = s.providers.filter((p) => p.enabled && p.vision)
    if (candidates.length === 0) return null
    const chosen = candidates.find((p) => p.id === s.activeProviderId) ?? candidates[0]
    return { provider: this.build(chosen), model: chosen.model, id: chosen.id, label: chosen.label }
  }
}
