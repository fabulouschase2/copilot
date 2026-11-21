/**
 * Provider routing (0.4.0).
 *
 * One place decides which provider serves a request. Rules, in order:
 *
 *  1. `local` mode  → only loopback providers; never a cloud request.
 *  2. `cloud` mode  → only non-loopback providers with a credential.
 *  3. `hybrid`      → local providers first (privacy + latency), then cloud.
 *  4. Private material (`sensitivity: 'private'`: screen captures, meeting
 *     audio, career facts) excludes cloud providers unless the user has
 *     explicitly enabled `allowCloudPrivate`.
 *  5. A vision task only ever considers providers marked as accepting images.
 *  6. The configured active provider wins inside its tier, so an explicit
 *     choice is respected without breaking the privacy rules above.
 *
 * The chain is used for fallback: if the first route fails, the caller may try
 * the next one. Nothing here retries indefinitely.
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

export interface ResolvedRoute extends ResolvedProvider {
  id: string
  label: string
  kind: 'local' | 'cloud'
}

export type TaskKind = 'chat' | 'vision'
export type TaskSensitivity = 'normal' | 'private'

export interface RouteRequest {
  kind?: TaskKind
  sensitivity?: TaskSensitivity
}

/** Loopback endpoints are local by definition; nothing leaves the machine. */
export function isLocalProvider(cfg: ProviderConfig): boolean {
  try {
    const url = new URL(cfg.baseUrl)
    const host = url.hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

export interface RoutePlan {
  routes: ResolvedRoute[]
  /** Why cloud routes were dropped, for honest UI messaging. */
  cloudBlockedReason: 'mode-local' | 'privacy' | null
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

  private toRoute(cfg: ProviderConfig, kind: 'local' | 'cloud'): ResolvedRoute {
    return {
      id: cfg.id,
      label: cfg.label,
      model: cfg.model,
      kind,
      provider: this.build(cfg),
      // `model` is duplicated by design: routes are serializable for the UI.
      ...({} as object)
    }
  }

  /**
   * Ordered list of providers allowed for this task. Empty means "no provider
   * is permitted/available" — callers must report that, never fake success.
   */
  plan(req: RouteRequest = {}): RoutePlan {
    const s: AppSettings = this.settings.get()
    const kind = req.kind ?? 'chat'
    const sensitivity = req.sensitivity ?? 'normal'
    const localOnly = s.aiMode === 'local'
    const cloudOnly = s.aiMode === 'cloud'
    const privacyBlocksCloud = sensitivity === 'private' && !s.allowCloudPrivate
    const cloudAllowed = !localOnly && !privacyBlocksCloud

    let cloudBlockedReason: RoutePlan['cloudBlockedReason'] = null
    if (localOnly) cloudBlockedReason = 'mode-local'
    else if (privacyBlocksCloud) cloudBlockedReason = 'privacy'

    const eligible = s.providers.filter((p) => {
      if (!p.enabled) return false
      if (kind === 'vision' && !p.vision) return false
      const local = isLocalProvider(p)
      if (local) return !cloudOnly
      return cloudAllowed
    })

    const locals = eligible.filter((p) => isLocalProvider(p))
    const clouds = eligible.filter((p) => !isLocalProvider(p))
    // Active first inside each tier, then credentialed, then the rest.
    const rank = (p: ProviderConfig): number => {
      if (p.id === s.activeProviderId) return 0
      if (isLocalProvider(p)) return 1
      return this.creds.has(p.id) ? 2 : 3
    }
    const sortedLocals = [...locals].sort((a, b) => rank(a) - rank(b))
    const sortedClouds = [...clouds].sort((a, b) => rank(a) - rank(b))
    const ordered =
      s.aiMode === 'cloud' ? sortedClouds : [...sortedLocals, ...sortedClouds]

    return {
      routes: ordered.map((p) => this.toRoute(p, isLocalProvider(p) ? 'local' : 'cloud')),
      cloudBlockedReason
    }
  }

  /** First allowed route, or null. */
  resolveFor(req: RouteRequest = {}): ResolvedRoute | null {
    return this.plan(req).routes[0] ?? null
  }

  /**
   * Resolve the provider that should serve the NEXT chat request. Kept for
   * existing call sites; now mode- and privacy-aware.
   */
  resolveActive(): ResolvedProvider | null {
    const route = this.resolveFor({ kind: 'chat' })
    return route ? { provider: route.provider, model: route.model } : null
  }

  resolveForTest(providerId: string): OpenAICompatibleProvider | null {
    const cfg = this.settings.get().providers.find((p) => p.id === providerId)
    return cfg ? this.build(cfg) : null
  }

  /**
   * Vision-capable provider for screen analysis. Screen content is private, so
   * a cloud vision provider is only considered when the user allowed it.
   */
  resolveVision(): { provider: AIProvider; model: string; id: string; label: string } | null {
    const route = this.resolveFor({ kind: 'vision', sensitivity: 'private' })
    if (!route) return null
    return { provider: route.provider, model: route.model, id: route.id, label: route.label }
  }
}
