import { useEffect, useRef, useState } from 'react'

/**
 * Meeting mode (Module F). Summary/actions/question generation runs on the
 * CURRENT session only (saved sources are explicit opt-ins at the request
 * level). Generated notes load into an editable field; export goes through
 * a user-initiated save dialog in the main process.
 */
interface SavedMeeting {
  meetingId: string
  title: string
  preview: string
}

export function MeetingPanel(): React.JSX.Element {
  const [notes, setNotes] = useState('')
  const [transcriptAccum, setTranscriptAccum] = useState('')
  const [saved, setSaved] = useState<SavedMeeting[]>([])
  const [busy, setBusy] = useState<'summary' | 'actions' | 'ask' | null>(null)
  const [question, setQuestion] = useState('')
  const [askAnswer, setAskAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sources, setSources] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const targetRef = useRef<'notes' | 'ask'>('notes')

  useEffect(() => {
    const offSeg = window.copilot.onTranscriptSegment((e) => {
      setTranscriptAccum((prev) => (prev + '\n' + e.text).slice(-400_000))
    })
    return offSeg
  }, [])

  const refreshSaved = (): void => {
    void window.copilot.listMeetings().then((res) => setSaved(res.meetings))
  }
  useEffect(refreshSaved, [])

  useEffect(() => {
    const offDelta = window.copilot.onModeDelta((e) => {
      if (e.channel !== 'meeting' || e.requestId !== requestIdRef.current) return
      if (targetRef.current === 'notes') setNotes((prev) => prev + e.delta)
      else setAskAnswer((prev) => prev + e.delta)
    })
    const offResult = window.copilot.onModeResult((e) => {
      if (e.channel !== 'meeting' || e.requestId !== requestIdRef.current) return
      setBusy(null)
      if (e.status === 'error') setError(e.message ?? 'Generation failed.')
      if (e.contextUsed.length > 0) {
        setSources(e.contextUsed.map((c) => `${c.displayName} (${Math.round(c.score * 100)}%)`).join(', '))
      } else setSources(null)
    })
    const offError = window.copilot.onModeError((e) => {
      if (e.channel === 'meeting' && e.requestId === requestIdRef.current) setError(e.message)
    })
    return () => {
      offDelta()
      offResult()
      offError()
    }
  }, [])

  const run = async (kind: 'summary' | 'actions'): Promise<void> => {
    setError(null)
    setExportMsg(null)
    targetRef.current = 'notes'
    setNotes('')
    setBusy(kind)
    const res = await window.copilot.generateMeeting({ kind, includeDocuments: false, includeProfile: false })
    if (res.ok && res.requestId) requestIdRef.current = res.requestId
    else {
      setError(res.message ?? 'Could not start generation.')
      setBusy(null)
    }
  }

  const ask = async (): Promise<void> => {
    if (!question.trim() || busy) return
    setError(null)
    targetRef.current = 'ask'
    setAskAnswer('')
    setBusy('ask')
    const res = await window.copilot.askMeeting({ question: question.trim() })
    if (res.ok && res.requestId) requestIdRef.current = res.requestId
    else {
      setError(res.message ?? 'Could not ask.')
      setBusy(null)
    }
  }

  const stop = (): void => window.copilot.cancelMeeting()

  const exportNotes = async (format: 'markdown' | 'txt'): Promise<void> => {
    if (!notes.trim()) return
    setExportMsg(null)
    const res = await window.copilot.exportNotes({ content: notes, format })
    if (res.ok) setExportMsg('Saved.')
    else if (res.canceled) setExportMsg(null)
    else setError(res.message ?? 'Export failed.')
  }

  return (
    <div className="chat">
      <div className="t-status">
        <span className="dot" />
        <span>Meeting mode · current session only · generation runs when you click</span>
        <span className="grow" />
        <button className="secondary" disabled={!!busy} onClick={() => void run('summary')}>
          Summarize meeting
        </button>
        <button className="secondary" disabled={!!busy} onClick={() => void run('actions')}>
          Extract action items
        </button>
      </div>

      <div className="messages">
        <textarea
          className="notes-editor"
          value={notes}
          placeholder="Generated meeting notes appear here and stay fully editable before export."
          onChange={(e) => setNotes(e.target.value)}
        />
        {sources && <div className="meta-screen">sources: {sources}</div>}
        {askAnswer && <div className="bubble assistant">{askAnswer}</div>}
      </div>

      <div className="composer t-start">
        <div className="row">
          <input
            className="grow"
            type="text"
            value={question}
            placeholder="Ask about the current meeting…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void ask()
            }}
          />
          {busy ? (
            <button className="secondary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!question.trim()} onClick={() => void ask()}>
              Ask
            </button>
          )}
        </div>
        <div className="row">
          <button
            className="secondary"
            disabled={!notes.trim()}
            onClick={() =>
              void window.copilot
                .saveMeeting({
                  meetingId: 'mtg-' + Date.now().toString(36),
                  title: 'Meeting ' + new Date().toLocaleString(),
                  transcript: transcriptAccum,
                  notes
                })
                .then((r) => {
                  setExportMsg(r.ok ? 'Meeting saved.' : r.message ?? 'Save failed')
                  refreshSaved()
                })
            }
          >
            Save meeting
          </button>
          <button className="secondary" disabled={!notes.trim()} onClick={() => void exportNotes('markdown')}>
            Export Markdown
          </button>
          <button className="secondary" disabled={!notes.trim()} onClick={() => void exportNotes('txt')}>
            Export plain text
          </button>
          <span className="grow" />
          <button
            className="secondary"
            onClick={() => {
              setNotes('')
              setAskAnswer('')
              setExportMsg(null)
              setTranscriptAccum('')
            }}
          >
            Clear
          </button>
        </div>
        {saved.length > 0 && (
          <div className="row wrap">
            <span className="hint">Saved:</span>
            {saved.map((m) => (
              <span key={m.meetingId} className="row compact" style={{ gap: 4 }}>
                <button
                  className="chip"
                  title="Open this saved meeting"
                  onClick={() =>
                    void window.copilot.getMeeting(m.meetingId).then((r) => {
                      if (r && r.ok) setNotes(r.notes)
                    })
                  }
                >
                  {m.title}
                </button>
                <button
                  className="meta-btn"
                  title="Delete saved meeting"
                  onClick={() => void window.copilot.deleteMeeting(m.meetingId).then(refreshSaved)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {exportMsg && <div className="hint">{exportMsg}</div>}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  )
}
