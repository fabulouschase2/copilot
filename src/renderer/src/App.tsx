import { useCallback, useEffect, useState } from 'react'
import { AppSettings, DEFAULT_SETTINGS, TranscriptStatusEvent } from '../../shared/protocol'
import { InterviewPanel } from './InterviewPanel'
import { MeetingPanel } from './MeetingPanel'
import { SetupPanel } from './SetupPanel'
import { ChatPanel } from './ChatPanel'

type View = 'interview' | 'meetings' | 'chat' | 'setup'

/**
 * Compact Poisely-style shell: a status header with Read screen / Setup /
 * pin / theme, a one-row nav (Interview · Meetings · Chat), and the primary
 * interview workspace. No second navigation layer, no dashboard.
 */
export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [view, setView] = useState<View>('interview')
  const [pinned, setPinned] = useState(false)
  const [session, setSession] = useState<TranscriptStatusEvent | null>(null)
  const [screenTrigger, setScreenTrigger] = useState(0)

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

  const sessionLabel =
    session === null || session.state === 'stopped'
      ? 'Idle'
      : session.state === 'listening'
        ? 'Listening'
        : session.state === 'paused'
          ? 'Paused'
          : 'Session'

  return (
    <div className="app" data-theme={settings.theme}>
      <div className="header">
        <span className={`session-pill ${sessionLabel !== 'Idle' ? 'session-live' : ''}`}>{sessionLabel}</span>
        <span className="grow" />
        <button className="chip" title="Read the current screen (Ctrl+Alt+R)" onClick={() => { setView('interview'); setScreenTrigger((t) => t + 1) }}>
          Read screen
        </button>
        <button className={`chip ${view === 'setup' ? 'chip-active' : ''}`} title="Setup" onClick={() => setView(view === 'setup' ? 'interview' : 'setup')}>
          ⚙ Setup
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
          {(['interview', 'meetings', 'chat'] as const).map((v) => (
            <button key={v} className={`nav-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
              {v === 'interview' ? 'Interview' : v === 'meetings' ? 'Meetings' : 'Chat'}
            </button>
          ))}
          <span className="grow" />
        <button className={`nav-btn ${view === 'setup' ? 'active' : ''}`} onClick={() => setView('setup')}>
          Setup
        </button>
      </div>

      <div className="view">
        {view === 'interview' && <InterviewPanel settings={settings} screenTrigger={screenTrigger} />}
        {view === 'meetings' && <MeetingPanel />}
        {view === 'chat' && <ChatPanel settings={settings} onOpenSettings={() => setView('setup')} />}
        {view === 'setup' && (
          <SetupPanel settings={settings} onChange={persistSettings} onOpenInterview={() => setView('interview')} />
        )}
      </div>
    </div>
  )
}
