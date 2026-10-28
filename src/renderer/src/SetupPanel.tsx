import { useEffect, useState } from 'react'
import {
  AppSettings,
  ContextSourceInfo,
  ProfileCategory,
  ProviderInfo
} from '../../shared/protocol'
import { SetupProvidersInline, SetupSttInline } from './SetupProvidersInline'

/**
 * Setup — the real configuration screen (Stage 10 UI rebuild).
 * Groups: Profile · Resume & documents · Interview context · Listening ·
 * Response · Providers (chat + transcription) · Data storage.
 * Every control writes real state through the existing IPC/services.
 */
export function SetupPanel(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onOpenInterview: () => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [sources, setSources] = useState<ContextSourceInfo[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [factText, setFactText] = useState('')
  const [factCategory, setFactCategory] = useState<ProfileCategory>('background')
  const [jd, setJd] = useState('')
  const [persistMsg, setPersistMsg] = useState<string | null>(null)
  const [persistence, setPersistence] = useState<import('../../shared/protocol').ContextPersistenceStatus | null>(null)
  const [tests, setTests] = useState<Record<string, { result?: import('../../shared/protocol').ProviderTestResult; busy?: boolean }>>({})
  const [section, setSection] = useState<'profile' | 'providers' | 'data'>('profile')

  const refresh = (): void => {
    void window.copilot.listContextSources().then((res) => {
      setSources(res.sources)
      const jdDoc = res.sources.find((s) => s.sourceId === 'job-description')
      setJd(jdDoc ? jdDoc.preview : '')
    })
    void window.copilot.listProviders().then(setProviders)
    void window.copilot.persistenceStatus().then(setPersistence)
  }

  useEffect(refresh, [])

  const save = (next: AppSettings): void => onChange(next)

  const documents = sources.filter((s) => s.type === 'document')
  const facts = sources.filter((s) => s.type === 'profile')

  const importDocs = async (): Promise<void> => {
    setImportErrors([])
    const res = await window.copilot.importDocuments()
    const bad = res.results.filter((r) => r.status === 'failed')
    if (bad.length > 0) setImportErrors(bad.map((r) => `${r.displayName}: ${r.message ?? 'failed'}`))
    refresh()
  }

  const addFact = async (): Promise<void> => {
    if (!factText.trim()) return
    await window.copilot.applyProfileOp({ op: 'add', text: factText.trim(), category: factCategory })
    setFactText('')
    refresh()
  }

  const saveJd = async (): Promise<void> => {
    // The job description persists as a dedicated ranked document.
    await window.copilot.removeDocument('job-description')
    if (jd.trim()) {
      // Route through the profile-op store? It must rank as a document, so
      // save via the document pipeline using the dedicated id.
      await window.copilot.setJobDescription(jd.trim())
    }
    refresh()
  }

  const saveKey = async (id: string, secret: string): Promise<void> => {
    if (!secret) return
    const res = await window.copilot.setCredential(id, secret)
    if (!res.ok) setPersistMsg(res.message ?? 'Could not store key')
  }

  const testProvider = async (id: string): Promise<void> => {
    setTests((t) => ({ ...t, [id]: { busy: true } }))
    const result = await window.copilot.testProvider(id)
    setTests((t) => ({ ...t, [id]: { result } }))
  }

  return (
    <div className="setup">
      <div className="setup-tabs">
        {(['profile', 'providers', 'data'] as const).map((s) => (
          <button key={s} className={`pill ${section === s ? 'pill-active' : ''}`} onClick={() => setSection(s)}>
            {s === 'profile' ? 'Profile & context' : s === 'providers' ? 'Providers' : 'Data'}
          </button>
        ))}
      </div>

      {section === 'profile' && (
        <>
          <div className="card">
            <div className="section-title">Interview context (this interview)</div>
            <div className="row">
              <input
                className="grow"
                type="text"
                placeholder="Company"
                value={settings.interview.company}
                onChange={(e) => save({ ...settings, interview: { ...settings.interview, company: e.target.value } })}
              />
              <input
                className="grow"
                type="text"
                placeholder="Role"
                value={settings.interview.role}
                onChange={(e) => save({ ...settings, interview: { ...settings.interview, role: e.target.value } })}
              />
            </div>
            <div className="row">
              <textarea
                className="grow jd"
                placeholder="Job description (paste it here — it is ranked as context for every answer)"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
              />
            </div>
            <div className="row">
              <button className="primary" onClick={() => void saveJd()}>
                Save job description
              </button>
            </div>
            <div className="hint">Company and role save as you type. The job description ranks alongside your resume.</div>
          </div>

          <div className="card">
            <div className="section-title">Profile & background (reusable facts)</div>
            <div className="row">
              <input
                className="grow"
                type="text"
                value={factText}
                placeholder="e.g. 6 years of TypeScript; led a team of four"
                onChange={(e) => setFactText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && factText.trim()) void addFact()
                }}
              />
              <select value={factCategory} onChange={(e) => setFactCategory(e.target.value as ProfileCategory)}>
                <option value="background">background</option>
                <option value="skill">skill</option>
                <option value="preference">preference</option>
                <option value="project">project</option>
                <option value="other">other</option>
              </select>
              <button className="secondary" disabled={!factText.trim()} onClick={() => void addFact()}>
                Add
              </button>
            </div>
            {facts.map((f) => (
              <div key={f.sourceId} className="row compact">
                <span className="badge">{f.category}</span>
                <span className="grow">{f.preview}</span>
                <button
                  className="meta-btn"
                  onClick={() => void window.copilot.applyProfileOp({ op: 'remove', factId: f.sourceId }).then(refresh)}
                >
                  remove
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-title">Resume & documents</div>
            <div className="row">
              <button className="primary" onClick={() => void importDocs().then(refresh)}>
                Import PDF / TXT / MD…
              </button>
            </div>
            {importErrors.map((e, i) => (
              <div key={i} className="error-text">
                {e}
              </div>
            ))}
            {documents.map((d) => (
              <div key={d.sourceId} className="row compact">
                <span className={`badge ${d.extractionStatus === 'ready' ? 'ok' : 'err'}`}>{d.extractionStatus}</span>
                <span className="grow">{d.displayName}</span>
                <button className="meta-btn" onClick={() => void window.copilot.removeDocument(d.sourceId).then(refresh)}>
                  remove
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-title">Response & listening</div>
            <div className="row">
              <label>Response</label>
              <select
                value={settings.responseMode}
                onChange={(e) => save({ ...settings, responseMode: e.target.value as 'concise' | 'detailed' })}
              >
                <option value="concise">Concise</option>
                <option value="detailed">Detailed</option>
              </select>
              <label>Answer delay</label>
              <select
                value={String(settings.interview.delaySeconds)}
                onChange={(e) =>
                  save({ ...settings, interview: { ...settings.interview, delaySeconds: Number(e.target.value) } })
                }
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>
                    {n}s
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={settings.interview.autoAnswer}
                  onChange={(e) =>
                    save({ ...settings, interview: { ...settings.interview, autoAnswer: e.target.checked } })
                  }
                />{' '}
                auto-answer
              </label>
            </div>
            <div className="row">
              <label>Listen to</label>
              <select
                value={settings.interview.source}
                onChange={(e) =>
                  save({ ...settings, interview: { ...settings.interview, source: e.target.value as 'mic' | 'system' } })
                }
              >
                <option value="mic">Microphone</option>
                <option value="system">System audio</option>
              </select>
              <label>Transcription language</label>
              {settings.stt.providers[0] ? (
                <input
                  className="grow"
                  type="text"
                  value={settings.stt.providers[0].language}
                  onChange={(e) =>
                    onChange({
                      ...settings,
                      stt: {
                        ...settings.stt,
                        providers: settings.stt.providers.map((p, i) =>
                          i === 0 ? { ...p, language: e.target.value } : p
                        )
                      }
                    })
                  }
                />
              ) : (
                <span className="badge">no STT provider</span>
              )}
            </div>
            <div className="hint">
              Wait-before-answering applies when a question is detected while listening; the countdown resets if speech
              continues.
            </div>
          </div>

          <div className="card">
            <div className="section-title">Appearance</div>
            <div className="row">
              <label>Theme</label>
              <select value={settings.theme} onChange={(e) => save({ ...settings, theme: e.target.value as 'dark' | 'light' })}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
        </>
      )}

      {section === 'providers' && (
        <>
          {providers.map((p) => (
            <div key={p.id} className="card">
              <div className="row wrap">
                <span className="badge">{p.enabled ? 'enabled' : 'off'}</span>
                <span className="grow">{p.label}</span>
                <span className="badge">{p.model}</span>
                {p.vision && <span className="badge ok">vision</span>}
              </div>
              <div className="row">
                <button className="primary" onClick={() => void testProvider(p.id)} disabled={tests[p.id]?.busy}>
                  {tests[p.id]?.busy ? 'Testing…' : 'Test connection'}
                </button>
                {tests[p.id]?.result && (
                  <span className={`badge ${tests[p.id]!.result!.ok ? 'ok' : 'err'}`}>
                    {tests[p.id]!.result!.message}
                    {tests[p.id]!.result!.latencyMs !== null ? ` · ${tests[p.id]!.result!.latencyMs} ms` : ''}
                  </span>
                )}
              </div>
              <div className="row">
                <input
                  className="grow"
                  type="password"
                  placeholder="API key (stored OS-encrypted)"
                  onChange={(e) => setPersistMsg('')}
                  onBlur={(e) => {
                    if (e.target.value) void saveKey(p.id, e.target.value).then(() => refresh())
                  }}
                />
              </div>
            </div>
          ))}
          <div className="card">
            <div className="section-title">Provider management</div>
            <div className="hint">
              Add, remove, and switch providers in the full provider list below (kept from the previous settings view).
            </div>
            <ProviderEditor settings={settings} onChange={save} />
          </div>
        </>
      )}

      {section === 'data' && (
        <>
          <div className="card">
            <div className="section-title">Storage</div>
            <div className="hint">
              {persistence
                ? `SQLite v${persistence.schemaVersion} · ${persistence.counts.documents} documents · ${persistence.counts.facts} facts · ${persistence.backupsAvailable} backup(s)`
                : '…'}
            </div>
            <div className="row">
              <button className="secondary" onClick={() => void window.copilot.backupNow().then((r) => { setPersistMsg(r.message ?? null); refresh() })}>
                Back up now
              </button>
              <button className="secondary" onClick={() => void window.copilot.restoreBackup().then((r) => { setPersistMsg(r.message ?? null); refresh() })}>
                Restore latest backup
              </button>
              <button className="danger" onClick={() => void window.copilot.clearSessionContext()}>
                Clear session context
              </button>
            </div>
            {persistMsg && <div className="hint">{persistMsg}</div>}
          </div>
          <div className="card">
            <div className="section-title">Retrieval preview</div>
            <RetrievalPreview />
          </div>
          <div className="card">
            <div className="section-title">Privacy</div>
            <div className="hint">
              Everything is stored locally. Documents, profile facts, and the job description are sent only to the
              provider you configure, only when you trigger an action. Transcripts and screen observations are never
              persisted. Free API tiers may retain submitted content — avoid confidential material.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Compact retrieval preview (moved from the old Context tab). */
function RetrievalPreview(): React.JSX.Element {
  const [question, setQuestion] = useState('What is my relevant experience?')
  const [out, setOut] = useState<{ items: Array<{ itemId: string; type: string; displayName: string; text: string; score: number; reason: string }>; estimatedTokens: number } | null>(null)
  return (
    <>
      <div className="row">
        <input
          className="grow"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void window.copilot.previewContext({ question }).then(setOut)
          }}
        />
        <button className="secondary" onClick={() => void window.copilot.previewContext({ question }).then(setOut)}>
          Preview
        </button>
      </div>
      {out && (
        <div className="hint">
          {out.items.length === 0
            ? 'Nothing would be attached.'
            : `${out.items.length} item(s), ~${out.estimatedTokens} tokens:`}
          <ul>
            {out.items.map((i) => (
              <li key={i.itemId}>
                <b>[{i.type}] {i.displayName}</b> — {i.score}: {i.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

/** The full provider editor (chat + STT + storage), carried over unchanged. */
function ProviderEditor(props: { settings: AppSettings; onChange: (s: AppSettings) => void }): React.JSX.Element {
  const { settings, onChange } = props
  return (
    <>
      <div className="section-title">Chat providers</div>
      <SetupProvidersInline settings={settings} onChange={onChange} />
      <div className="section-title">Transcription providers</div>
      <SetupSttInline settings={settings} onChange={onChange} />
    </>
  )
}

