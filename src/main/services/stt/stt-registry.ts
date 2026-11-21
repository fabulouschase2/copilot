/**
 * Resolves the active STT adapter from settings + credential store (Module I).
 * Rebuilt per lookup so provider changes apply to the next session without
 * restart. Returns adapter + display metadata for the consent UI.
 */
import { STTProvider, STTProviderInfo } from '../../../shared/protocol'
import { CredentialStore } from '../credential-store'
import { SettingsStore } from '../settings-store'
import { DeepgramStt } from './deepgram-stt'
import { LocalWhisperManager, LocalWhisperStt } from './local-whisper'
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
    private creds: CredentialStore,
    private localWhisper?: LocalWhisperManager
  ) {}

  listProviders(): STTProviderInfo[] {
    return this.settings.get().stt.providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      protocol: p.protocol,
      enabled: p.enabled,
      model: p.model,
      language: p.language,
      baseUrl: p.baseUrl,
      hasCredential: this.creds.has(p.id)
    }))
  }

  /** Build the adapter for ONE specific provider (used by Test connection). */
  resolveById(providerId: string): { adapter: SttAdapter; label: string } | null {
    const chosen = this.settings.get().stt.providers.find((p) => p.id === providerId)
    if (!chosen) return null
    return { adapter: this.build(chosen), label: chosen.label }
  }

  resolveActive(): ResolvedStt | null {
    const stt = this.settings.get().stt
    const candidates = stt.providers.filter((p) => p.enabled)
    if (candidates.length === 0) return null
    const chosen = candidates.find((p) => p.id === stt.activeSttProviderId) ?? candidates[0]
    return {
      adapter: this.build(chosen),
      label: chosen.label,
      kind: this.isLocal(chosen) ? 'local' : 'cloud',
      language: chosen.language
    }
  }

  private isLocal(p: STTProvider): boolean {
    return p.protocol === 'whisper-cpp' || /local/i.test(p.label) || /localhost|127\.0\.0\.1/.test(p.baseUrl)
  }

  private build(chosen: STTProvider): SttAdapter {
    if (chosen.kind === 'stt-segment') {
      // whisper.cpp exposes /inference only (no OpenAI-compatible route), so it
      // gets its own adapter and a managed child process.
      if (chosen.protocol === 'whisper-cpp' && this.localWhisper) {
        return new LocalWhisperStt(this.localWhisper, chosen.language)
      }
      return new SegmentStt({
        id: chosen.id,
        label: chosen.label,
        baseUrl: chosen.baseUrl,
        apiKey: this.creds.get(chosen.id) ?? '',
        model: chosen.model,
        language: chosen.language
      })
    }
    return new DeepgramStt({
      id: chosen.id,
      label: chosen.label,
      baseUrl: chosen.baseUrl,
      apiKey: this.creds.get(chosen.id) ?? '',
      model: chosen.model,
      language: chosen.language
    })
  }
}
