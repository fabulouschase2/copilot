import { useCallback, useEffect, useState } from 'react'
import { AppSettings, DEFAULT_SETTINGS, TranscriptStatusEvent } from '../../shared/protocol'
import { InterviewPanel } from './InterviewPanel'
import { MeetingPanel } from './MeetingPanel'
import { PracticePanel } from './PracticePanel'
import { SetupPanel } from './SetupPanel'
import { ChatPanel } from './ChatPanel'
import { ReadScreenModal } from './ReadScreenModal'

type View = 'interview' | 'practice' | 'meetings' | 'chat' | 'setup'

const NAV: Array<{ id: View; label: string }> = [
  { id: 'interview', label: 'Interview' },
  { id: 'practice', label: 'Practice' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'chat', label: 'Chat' }
]

/**
 * Copilot shell: header (status · provider · Read screen · Setup · pin ·
 * theme), one-row nav (Interview · Practice · Meetings · Chat), and the
 * active workspace. Settings is reachable from the header only — no
 * duplicated navigation, no dashboard.
 */
export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [view, setView] = useState<View>('interview')
  const [pinned, setPinned] = useState(false)
  const [session, setSession] = useState<TranscriptStatusEvent | null>(null)
  const [screenOpen, setScreenOpen] = useState(false)

  useEffect(() => {
    void window.copilot.getSettings().then(setSettings)
    return window.copilot.onTranscriptStatus((e) => {
      setSession((cur) => (cur === null || cur.sessionId === e.sessionId || e.state === 'stopped' ? e : cur))
    })
  }, [])

  const persistSettings = useCallback((next: AppSettings): void => {
    setSettings(next)
    void window.copilot.setSettings(next).then(setSettings)
  }, [])

  const listening = session !== null && session.state === 'listening'
  const sessionLabel =
    session === null || session.state === 'stopped'
      ? 'Idle'
      : session.state === 'listening'
        ? session.purpose === 'meeting'
          ? 'Recording meeting'
          : session.purpose === 'practice'
            ? 'Listening (practice)'
            : 'Listening'
        : session.state === 'paused'
          ? 'Paused'
          : 'Session'

  const activeProviderLabel =
    settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled)?.label ??
    settings.providers.find((p) => p.enabled)?.label ??
    null

  const openSettings = (): void => setView((v) => (v === 'setup' ? 'interview' : 'setup'))

  return (
    <div className="app" data-theme={settings.theme}>
      <div className="header">
        <span className="app-title">
          <span className="logo" />
          Copilot
        </span>
        <span className={`session-pill ${session?.state === 'listening' ? (session.purpose === 'meeting' ? 'session-rec' : 'session-live') : ''}`}>
          {sessionLabel}
        </span>
        <span className="grow" />
        {activeProviderLabel && <span className="badge accent">{activeProviderLabel}</span>}
        <button className="chip" title="Read the current screen (Ctrl+Alt+R)" onClick={() => setScreenOpen(true)}>
          Read screen
        </button>
        <button className={`chip ${view === 'setup' ? 'chip-active' : ''}`} title="Settings" onClick={openSettings}>
          ⚙ Settings
        </button>
        <button
          className={`icon ${pinned ? 'pinned' : ''}`}
          title={pinned ? 'Unpin window' : 'Pin window (always on top)'}
          onClick={() => void window.copilot.togglePin().then(setPinned)}
        >
          📌
        </button>
        <button
          className="icon"
          title="Toggle theme"
          onClick={() => persistSettings({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}
        >
          {settings.theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <div className="nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${view === n.id ? 'active' : ''}`}
            onClick={() => setView(n.id)}
          >
            {n.label}
            {n.id === 'interview' && listening && session?.purpose === 'interview' && <span className="nav-dot" />}
            {n.id === 'meetings' && listening && session?.purpose === 'meeting' && <span className="nav-dot" />}
            {n.id === 'practice' && listening && session?.purpose === 'practice' && <span className="nav-dot" />}
          </button>
        ))}
      </div>

      <div className="view">
        {view === 'interview' && <InterviewPanel settings={settings} onOpenScreenRead={() => setScreenOpen(true)} />}
        {view === 'practice' && <PracticePanel settings={settings} />}
        {view === 'meetings' && <MeetingPanel settings={settings} />}
        {view === 'chat' && <ChatPanel settings={settings} onOpenSettings={() => setView('setup')} />}
        {view === 'setup' && (
          <SetupPanel settings={settings} onChange={persistSettings} onOpenInterview={() => setView('interview')} />
        )}
      </div>

      {screenOpen && (
        <ReadScreenModal
          onClose={() => setScreenOpen(false)}
          settings={settings}
        />
      )}
    </div>
  )
}
