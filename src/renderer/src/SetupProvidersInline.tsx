import { useCallback, useEffect, useState } from 'react'
import { AppSettings, ProviderConfig, STTProvider, STTProviderInfo } from '../../shared/protocol'
import { KeyField } from './KeyField'

/**
 * Provider rows for Setup, with explicit credential management:
 * Save key (click-only), Show/Hide, Saved/failed feedback, key-saved badge
 * and per-provider Test connection. Credentials travel only through
 * window.copilot.setCredential → the OS-encrypted CredentialStore.
 */

/** Compact chat-provider rows for Setup (full editing preserved). */
export function SetupProvidersInline(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [credStatus, setCredStatus] = useState<Record<string, boolean>>({})

  const refreshCreds = useCallback((): void => {
    void window.copilot.listProviders().then((list) => {
      setCredStatus(Object.fromEntries(list.map((p) => [p.id, p.hasCredential])))
    })
  }, [])
  useEffect(refreshCreds, [refreshCreds])

  const patch = (id: string, p: Partial<ProviderConfig>): void =>
    onChange({ ...settings, providers: settings.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) })

  return (
    <>
      {settings.providers.map((p) => (
        <div key={p.id} className="card" style={{ gap: 6 }}>
          <div className="row compact" style={{ borderBottom: 'none' }}>
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
            <button className="meta-btn" onClick={() => onChange({ ...settings, providers: settings.providers.filter((x) => x.id !== p.id) })}>
              ✕
            </button>
          </div>
          <KeyField providerId={p.id} hasCredential={credStatus[p.id] ?? false} onSaved={refreshCreds} />
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

/** Compact STT-provider rows for Setup, with key management + connection test. */
export function SetupSttInline(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [infos, setInfos] = useState<Record<string, STTProviderInfo>>({})
  const [tests, setTests] = useState<Record<string, { result?: import('../../shared/protocol').ProviderTestResult; busy?: boolean }>>({})

  const refreshInfos = useCallback((): void => {
    void window.copilot.listSttProviders().then((res) => {
      setInfos(Object.fromEntries(res.providers.map((p) => [p.id, p])))
    })
  }, [])
  useEffect(refreshInfos, [refreshInfos])

  const patch = (id: string, p: Partial<STTProvider>): void =>
    onChange({ ...settings, stt: { ...settings.stt, providers: settings.stt.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) } })

  const testConnection = async (id: string): Promise<void> => {
    setTests((t) => ({ ...t, [id]: { busy: true } }))
    const result = await window.copilot.testSttProvider(id)
    setTests((t) => ({ ...t, [id]: { result } }))
  }

  return (
    <>
      {settings.stt.providers.map((p) => (
        <div key={p.id} className="card" style={{ gap: 6 }}>
          <div className="row compact" style={{ borderBottom: 'none' }}>
            <input
              type="radio"
              name="active-stt"
              checked={settings.stt.activeSttProviderId === p.id}
              onChange={() => onChange({ ...settings, stt: { ...settings.stt, activeSttProviderId: p.id } })}
              title="Set active"
            />
            <input className="grow" type="text" value={p.label} onChange={(e) => patch(p.id, { label: e.target.value })} />
            <input type="text" value={p.model} placeholder="model" style={{ width: 110 }} onChange={(e) => patch(p.id, { model: e.target.value })} />
            <label title="Enabled">
              <input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.id, { enabled: e.target.checked })} /> on
            </label>
            <button className="meta-btn" onClick={() => onChange({ ...settings, stt: { ...settings.stt, providers: settings.stt.providers.filter((x) => x.id !== p.id) } })}>
              ✕
            </button>
          </div>
          <KeyField providerId={p.id} hasCredential={infos[p.id]?.hasCredential ?? false} onSaved={refreshInfos} />
          <div className="row compact" style={{ borderBottom: 'none' }}>
            <button className="secondary" disabled={tests[p.id]?.busy} onClick={() => void testConnection(p.id)}>
              {tests[p.id]?.busy ? 'Testing…' : 'Test connection'}
            </button>
            {tests[p.id]?.result && (
              <span className={`badge ${tests[p.id]!.result!.ok ? 'ok' : 'err'}`}>
                {tests[p.id]!.result!.message}
                {tests[p.id]!.result!.latencyMs !== null ? ` · ${tests[p.id]!.result!.latencyMs} ms` : ''}
              </span>
            )}
          </div>
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
