/**
 * AI mode and routing (0.4.0).
 *
 * The panel shows the three modes, the private-data permission, and the actual
 * routing order this build would use right now — computed by the same registry
 * that serves requests, so what you see is what runs.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, ProviderRoutesResult } from '../../shared/protocol'

interface Props {
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

const MODES: Array<{ id: AppSettings['aiMode']; label: string; hint: string }> = [
  {
    id: 'local',
    label: 'Local only',
    hint: 'Ollama + whisper.cpp. No cloud request is ever made.'
  },
  {
    id: 'hybrid',
    label: 'Hybrid (default)',
    hint: 'Local first; cloud only for tasks you allow.'
  },
  {
    id: 'cloud',
    label: 'Cloud only',
    hint: 'Configured cloud provider (e.g. Gemini). No local models used.'
  }
]

export function AiModePanel({ settings, onChange }: Props): React.JSX.Element {
  const [chat, setChat] = useState<ProviderRoutesResult | null>(null)
  const [vision, setVision] = useState<ProviderRoutesResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [c, v] = await Promise.all([
      window.copilot.listRoutes('chat', 'normal'),
      window.copilot.listRoutes('vision', 'private')
    ])
    setChat(c)
    setVision(v)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, settings.aiMode, settings.allowCloudPrivate, settings.providers])

  const blockReason = (r: ProviderRoutesResult | null): string | null => {
    if (!r || r.cloudBlockedReason === null) return null
    return r.cloudBlockedReason === 'mode-local'
      ? 'Local-only mode: cloud providers are excluded.'
      : 'Cloud providers are excluded because this task uses private material.'
  }

  return (
    <div className="card">
      <div className="section-title" style={{ marginTop: 0 }}>AI mode &amp; routing</div>
      <div className="row wrap">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`pill ${settings.aiMode === m.id ? 'pill-active' : ''}`}
            title={m.hint}
            onClick={() => onChange({ ...settings, aiMode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        {MODES.find((m) => m.id === settings.aiMode)?.hint}
      </div>

      <label className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={settings.allowCloudPrivate}
          disabled={settings.aiMode === 'local'}
          onChange={(e) => onChange({ ...settings, allowCloudPrivate: e.target.checked })}
        />
        <span>
          Allow cloud providers to process private material
          <span className="hint" style={{ display: 'block' }}>
            Screen captures, meeting audio and career facts stay on this machine unless this is on.
          </span>
        </span>
      </label>

      <div style={{ marginTop: 10 }}>
        <div className="hint">Chat routing now</div>
        <div className="row wrap" style={{ marginTop: 2 }}>
          {chat && chat.routes.length > 0 ? (
            chat.routes.map((r, i) => (
              <span key={r.id} className="badge">
                {i + 1}. {r.label} · {r.model} <span className="hint">({r.kind})</span>
              </span>
            ))
          ) : (
            <span className="badge err">no provider available</span>
          )}
        </div>
        {blockReason(chat) && <div className="hint">{blockReason(chat)}</div>}
      </div>

      <div style={{ marginTop: 8 }}>
        <div className="hint">Screen analysis (private) routing now</div>
        <div className="row wrap" style={{ marginTop: 2 }}>
          {vision && vision.routes.length > 0 ? (
            vision.routes.map((r, i) => (
              <span key={r.id} className="badge">
                {i + 1}. {r.label} · {r.model} <span className="hint">({r.kind})</span>
              </span>
            ))
          ) : (
            <span className="badge err">no vision provider available</span>
          )}
        </div>
        {blockReason(vision) && <div className="hint">{blockReason(vision)}</div>}
        {vision && vision.routes.length === 0 && !blockReason(vision) && (
          <div className="hint">
            Add a provider and tick “model accepts images”, or enable cloud processing above.
          </div>
        )}
      </div>
    </div>
  )
}
