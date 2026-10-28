import { useState } from 'react'
import { AppSettings, ProviderConfig, STTProvider } from '../../shared/protocol'

/** Compact chat-provider rows for Setup (full editing preserved). */
export function SetupProvidersInline(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [keyInput, setKeyInput] = useState<Record<string, string>>({})

  const patch = (id: string, p: Partial<ProviderConfig>): void =>
    onChange({ ...settings, providers: settings.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) })

  return (
    <>
      {settings.providers.map((p) => (
        <div key={p.id} className="row compact">
          <input
            type="radio"
            name="active-provider"
            checked={settings.activeProviderId === p.id}
            onChange={() => onChange({ ...settings, activeProviderId: p.id })}
            title="Set active"
          />
          <input className="grow" type="text" value={p.label} onChange={(e) => patch(p.id, { label: e.target.value })} />
          <input
            type="text"
            value={p.model}
            placeholder="model"
            style={{ width: 120 }}
            onChange={(e) => patch(p.id, { model: e.target.value })}
          />
          <label title="Model accepts images">
            <input type="checkbox" checked={p.vision} onChange={(e) => patch(p.id, { vision: e.target.checked })} /> 👁
          </label>
          <label title="Enabled">
            <input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.id, { enabled: e.target.checked })} /> on
          </label>
          <input
            type="password"
            placeholder="key"
            style={{ width: 110 }}
            value={keyInput[p.id] ?? ''}
            onChange={(e) => setKeyInput((k) => ({ ...k, [p.id]: e.target.value }))}
            onBlur={(e) => {
              if (e.target.value) {
                void window.copilot.setCredential(p.id, e.target.value)
                setKeyInput((k) => ({ ...k, [p.id]: '' }))
              }
            }}
          />
          <button className="meta-btn" onClick={() => onChange({ ...settings, providers: settings.providers.filter((x) => x.id !== p.id) })}>
            ✕
          </button>
        </div>
      ))}
      <button
        className="chip"
        onClick={() =>
          onChange({
            ...settings,
            providers: [
              ...settings.providers,
              {
                id: `p-${Date.now().toString(36)}`,
                label: 'New provider',
                kind: 'openai-compatible' as const,
                baseUrl: 'https://api.openai.com/v1',
                model: '',
                enabled: true,
                vision: false
              }
            ]
          })
        }
      >
        + Add chat provider
      </button>
    </>
  )
}

/** Compact STT-provider rows for Setup. */
export function SetupSttInline(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [keyInput, setKeyInput] = useState<Record<string, string>>({})

  const patch = (id: string, p: Partial<STTProvider>): void =>
    onChange({ ...settings, stt: { ...settings.stt, providers: settings.stt.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) } })

  return (
    <>
      {settings.stt.providers.map((p) => (
        <div key={p.id} className="row compact">
          <input type="radio" name="active-stt" checked={settings.stt.activeSttProviderId === p.id} onChange={() => onChange({ ...settings, stt: { ...settings.stt, activeSttProviderId: p.id } })} title="Set active" />
          <input className="grow" type="text" value={p.label} onChange={(e) => patch(p.id, { label: e.target.value })} />
          <input type="text" value={p.model} placeholder="model" style={{ width: 110 }} onChange={(e) => patch(p.id, { model: e.target.value })} />
          <label title="Enabled">
            <input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.id, { enabled: e.target.checked })} /> on
          </label>
          <input
            type="password"
            placeholder="key"
            style={{ width: 110 }}
            value={keyInput[p.id] ?? ''}
            onChange={(e) => setKeyInput((k) => ({ ...k, [p.id]: e.target.value }))}
            onBlur={(e) => {
              if (e.target.value) {
                void window.copilot.setCredential(p.id, e.target.value)
                setKeyInput((k) => ({ ...k, [p.id]: '' }))
              }
            }}
          />
          <button className="meta-btn" onClick={() => onChange({ ...settings, stt: { ...settings.stt, providers: settings.stt.providers.filter((x) => x.id !== p.id) } })}>
            ✕
          </button>
        </div>
      ))}
      <button
        className="chip"
        onClick={() =>
          onChange({
            ...settings,
            stt: {
              ...settings.stt,
              providers: [
                ...settings.stt.providers,
                {
                  id: `s-${Date.now().toString(36)}`,
                  label: 'New STT provider',
                  kind: 'stt-segment' as const,
                  baseUrl: 'https://api.groq.com/openai/v1',
                  model: 'whisper-large-v3',
                  language: 'en',
                  enabled: true
                }
              ]
            }
          })
        }
      >
        + Add transcription provider
      </button>
    </>
  )
}
