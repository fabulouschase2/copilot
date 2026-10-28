/**
 * Resolves the active STT adapter from settings + credential store (Module I).
 * Rebuilt per lookup so provider changes apply to the next session without
 * restart. Returns adapter + display metadata for the consent UI.
 */
import { CredentialStore } from '../credential-store'
import { SettingsStore } from '../settings-store'
import { DeepgramStt } from './deepgram-stt'
import { SegmentStt } from './segment-stt'
import { SttAdapter } from './types'

export interface ResolvedStt {
  adapter: SttAdapter
  label: string
  kind: 'cloud' | 'local'
  language: string
}

export class SttRegistry {
  constructor(
    private settings: SettingsStore,
    private creds: CredentialStore
  ) {}

  listProviders(): Array<{ id: string; label: string; kind: string; enabled: boolean; hasCredential: boolean }> {
    return this.settings.get().stt.providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      enabled: p.enabled,
      hasCredential: this.creds.has(p.id)
    }))
  }

  resolveActive(): ResolvedStt | null {
    const stt = this.settings.get().stt
    const candidates = stt.providers.filter((p) => p.enabled)
    if (candidates.length === 0) return null
    const chosen = candidates.find((p) => p.id === stt.activeSttProviderId) ?? candidates[0]
    const apiKey = this.creds.get(chosen.id) ?? ''
    const adapter: SttAdapter =
      chosen.kind === 'stt-segment'
        ? new SegmentStt({
            id: chosen.id,
            label: chosen.label,
            baseUrl: chosen.baseUrl,
            apiKey,
            model: chosen.model,
            language: chosen.language
          })
        : new DeepgramStt({
            id: chosen.id,
            label: chosen.label,
            baseUrl: chosen.baseUrl,
            apiKey,
            model: chosen.model,
            language: chosen.language
          })
    return {
      adapter,
      label: chosen.label,
      kind: /local/i.test(chosen.label) || /localhost|127\.0\.0\.1/.test(chosen.baseUrl) ? 'local' : 'cloud',
      language: chosen.language
    }
  }
}
