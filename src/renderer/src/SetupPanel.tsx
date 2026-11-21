import { useEffect, useState } from 'react'
import {
  AppSettings,
  ContextSourceInfo,
  ProfileCategory,
  ProfileInfo,
  ProviderInfo
} from '../../shared/protocol'
import { SetupProvidersInline, SetupSttInline } from './SetupProvidersInline'
import { WhisperPanel } from './WhisperPanel'
import { KeyField } from './KeyField'

/**
 * Settings — configuration surface (transformation rebuild).
 * Groups: Profiles · Profile & background · Résumé & documents ·
 * Interview context · Response & listening · Providers · Data.
 * Every control writes real state through the existing IPC/services.
 */

const LANGUAGES: Array<{ id: string; label: string }> = [
  { id: 'auto', label: 'Auto (match question)' },
  { id: 'en', label: 'English' },
  { id: 'de', label: 'German (Deutsch)' },
  { id: 'fr', label: 'French (Français)' },
  { id: 'es', label: 'Spanish (Español)' },
  { id: 'pt', label: 'Portuguese (Português)' },
  { id: 'it', label: 'Italian (Italiano)' },
  { id: 'nl', label: 'Dutch (Nederlands)' },
  { id: 'pl', label: 'Polish (Polski)' },
  { id: 'tr', label: 'Turkish (Türkçe)' },
  { id: 'hi', label: 'Hindi (हिन्दी)' },
  { id: 'zh', label: 'Chinese (中文)' },
  { id: 'ja', label: 'Japanese (日本語)' },
  { id: 'ko', label: 'Korean (한국어)' }
]

export function SetupPanel(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onOpenInterview: () => void
}): React.JSX.Element {
  const { settings, onChange } = props
  const [sources, setSources] = useState<ContextSourceInfo[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [factText, setFactText] = useState('')
  const [factCategory, setFactCategory] = useState<ProfileCategory>('background')
  const [newProfileName, setNewProfileName] = useState('')
  const [jd, setJd] = useState('')
  const [persistMsg, setPersistMsg] = useState<string | null>(null)
  const [persistence, setPersistence] = useState<import('../../shared/protocol').ContextPersistenceStatus | null>(null)
  const [tests, setTests] = useState<Record<string, { result?: import('../../shared/protocol').ProviderTestResult; busy?: boolean }>>({})
  const [section, setSection] = useState<'profile' | 'providers' | 'data'>('profile')
  const [factDetails, setFactDetails] = useState<import('../../shared/protocol').ProfileFactDetail[]>([])
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [extractMsg, setExtractMsg] = useState<string | null>(null)
  const [editingFact, setEditingFact] = useState<{ factId: string; text: string } | null>(null)

  const refresh = (): void => {
    void window.copilot.listContextSources().then((res) => {
      setSources(res.sources)
      const jdDoc = res.sources.find((s) => s.sourceId === 'job-description')
      setJd(jdDoc ? jdDoc.preview : '')
    })
    void window.copilot.listFactDetails().then((res) => setFactDetails(res.facts))
    void window.copilot.listProviders().then(setProviders)
    void window.copilot.listProfiles().then((res) => setProfiles(res.profiles))
    void window.copilot.persistenceStatus().then(setPersistence)
  }

  useEffect(refresh, [])

  const save = (next: AppSettings): void => onChange(next)

  const documents = sources.filter((s) => s.type === 'document')
  const factOp = (op: import('../../shared/protocol').ProfileFactOp): void => {
    void window.copilot.applyProfileOp(op).then(refresh)
  }
  const pendingFacts = factDetails.filter((f) => f.status === 'pending')
  const settledFacts = factDetails.filter((f) => f.status !== 'pending')

  const extractFacts = async (documentId: string): Promise<void> => {
    setExtractingId(documentId)
    setExtractMsg(null)
    try {
      const res = await window.copilot.extractFacts(documentId)
      if (res.ok) {
        setExtractMsg(
          `${res.added} fact(s) extracted and waiting for review` +
            (res.rejected.length > 0 ? ` · ${res.rejected.length} rejected as unverified` : '') +
            (res.providerLabel ? ` · ${res.providerLabel}` : '')
        )
      } else {
        setExtractMsg(
          (res.message ?? 'Extraction failed.') +
            (res.rejected.length > 0 ? ` (${res.rejected.length} unverified item(s) rejected)` : '')
        )
      }
      refresh()
    } finally {
      setExtractingId(null)
    }
  }
  const activeProfile = profiles.find((p) => p.profileId === settings.activeProfileId)

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
    if (jd.trim()) await window.copilot.setJobDescription(jd.trim())
    refresh()
  }

  const createProfile = async (): Promise<void> => {
    if (!newProfileName.trim()) return
    const res = await window.copilot.createProfile({ name: newProfileName.trim() })
    if (res.ok && res.profileId) {
      save({ ...settings, activeProfileId: res.profileId })
      setNewProfileName('')
    } else {
      setPersistMsg(res.message ?? 'Could not create the profile.')
    }
    refresh()
  }

  const deleteProfile = async (profileId: string): Promise<void> => {
    const res = await window.copilot.deleteProfile({ profileId })
    if (!res.ok) setPersistMsg(res.message ?? 'Could not delete the profile.')
    refresh()
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
            <div className="section-title">Personal profiles</div>
            <div className="profile-picker">
              {profiles.map((p) => (
                <span key={p.profileId} className="row" style={{ gap: 2 }}>
                  <button
                    className={`chip ${settings.activeProfileId === p.profileId ? 'chip-active' : ''}`}
                    onClick={() => save({ ...settings, activeProfileId: p.profileId })}
                    title={settings.activeProfileId === p.profileId ? 'Active profile' : 'Switch to this profile'}
                  >
                    {p.name} ({p.factCount})
                  </button>
                  {p.profileId !== 'default' && (
                    <button className="meta-btn" title="Delete this profile and its facts" onClick={() => void deleteProfile(p.profileId)}>
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="row">
              <input
                className="grow"
                type="text"
                placeholder="New profile name (e.g. Frontend track, Consulting)"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createProfile()}
              />
              <button className="secondary" disabled={!newProfileName.trim()} onClick={() => void createProfile()}>
                Create
              </button>
            </div>
            <div className="hint">
              Facts below belong to the active profile{activeProfile ? `: ${activeProfile.name}` : ''}. Documents are shared across profiles.
            </div>
          </div>

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
            {pendingFacts.length > 0 && (
              <div className="notice-box">
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Review extracted facts ({pendingFacts.length})
                </div>
                <div className="hint" style={{ marginBottom: 6 }}>
                  These were extracted from your documents. A fact becomes verified experience only
                  when you confirm it.
                </div>
                {pendingFacts.map((f) => (
                  <div key={f.factId} className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="badge warn">pending</span>
                    <div className="grow">
                      <div>{f.text}</div>
                      {f.sourceText && <div className="hint">Source: “{f.sourceText}”</div>}
                    </div>
                    <button className="chip" onClick={() => factOp({ op: 'confirm', factId: f.factId })}>
                      Confirm
                    </button>
                    <button className="meta-btn" onClick={() => factOp({ op: 'reject', factId: f.factId })}>
                      Reject
                    </button>
                  </div>
                ))}
              </div>
            )}

            {settledFacts.map((f) => (
              <div key={f.factId} className="row compact" style={{ alignItems: 'flex-start' }}>
                <span className={`badge ${f.status === 'confirmed' ? 'ok' : 'err'}`}>
                  {f.status === 'confirmed' ? 'verified' : 'rejected'}
                </span>
                <span className="badge">{f.category}</span>
                <div className="grow">
                  {editingFact?.factId === f.factId ? (
                    <div className="row">
                      <input
                        className="grow"
                        type="text"
                        value={editingFact.text}
                        onChange={(e) => setEditingFact({ factId: f.factId, text: e.target.value })}
                      />
                      <button
                        className="chip"
                        onClick={() => {
                          factOp({ op: 'update', factId: f.factId, text: editingFact.text.trim() })
                          setEditingFact(null)
                        }}
                      >
                        Save
                      </button>
                      <button className="meta-btn" onClick={() => setEditingFact(null)}>
                        cancel
                      </button>
                    </div>
                  ) : (
                    <div>{f.text}</div>
                  )}
                  {f.sourceText && <div className="hint">Source: “{f.sourceText}”</div>}
                </div>
                <button className="meta-btn" onClick={() => setEditingFact({ factId: f.factId, text: f.text })}>
                  edit
                </button>
                {f.status === 'rejected' && (
                  <button className="meta-btn" onClick={() => factOp({ op: 'confirm', factId: f.factId })}>
                    restore
                  </button>
                )}
                <button className="meta-btn" onClick={() => factOp({ op: 'remove', factId: f.factId })}>
                  remove
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-title">Résumé & documents</div>
            <div className="row">
              <button className="primary" onClick={() => void importDocs().then(refresh)}>
                Import PDF / DOCX / TXT / MD…
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
                <button
                  className="chip"
                  disabled={extractingId === d.sourceId}
                  title="Extract facts from this document for review"
                  onClick={() => void extractFacts(d.sourceId)}
                >
                  {extractingId === d.sourceId ? 'Extracting…' : 'Extract facts'}
                </button>
                <button className="meta-btn" onClick={() => void window.copilot.removeDocument(d.sourceId).then(refresh)}>
                  remove
                </button>
              </div>
            ))}
            {extractMsg && <div className="hint" style={{ marginTop: 6 }}>{extractMsg}</div>}
          </div>

          <div className="card">
            <div className="section-title">Response & listening</div>
            <div className="row">
              <label>Response language</label>
              <select
                value={settings.responseLanguage}
                onChange={(e) => save({ ...settings, responseLanguage: e.target.value })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
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
              Response language applies to interview answers, meeting notes, chat, and practice. The transcription
              language above configures the STT provider. Wait-before-answering applies when a question is detected
              while listening.
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
              <KeyField providerId={p.id} hasCredential={p.hasCredential} onSaved={refresh} />
            </div>
          ))}
          <div className="card">
            <div className="section-title">Provider management</div>
            <div className="hint">
              Add, remove, and switch providers below. Keys are OS-encrypted and never leave the main process.
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
              provider you configure, only when you trigger an action. Transcripts, audio, and screen observations are
              never persisted. Free API tiers may retain submitted content — avoid confidential material.
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
      <WhisperPanel settings={settings} onChange={onChange} />
    </>
  )
}
