import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  MeetingActionItem,
  MeetingDetail,
  MeetingSummary,
  TranscriptSegmentEvent,
  TranscriptStatusEvent
} from '../../shared/protocol'
import { startCapture, CaptureSession, CaptureError } from './audio/capture'
import { parseActionItems } from '../../shared/meeting-notes'
import { ErrorBox, NoticeBox, fmtDuration, shortTime } from './ui'

/**
 * Meetings — a COMPLETE independent lifecycle (transformation rebuild):
 *
 *  Before   : title, audio source, language, transcription provider shown.
 *  During   : Start/End controls, mic/system capture, live transcript with
 *             timestamps and source attribution (mic vs system), pause,
 *             resume, mute, elapsed timer, graceful device-loss handling.
 *  After    : summary auto-generates on end; notes editable; action items
 *             with evidence-only owners/deadlines; save/export/search/
 *             reopen/delete; ask questions about the open meeting.
 *
 * Sessions use a dedicated purpose ('meeting') — interview transcripts can
 * never leak into meeting data. No speaker diarization is claimed; segments
 * are labeled by capture source only.
 */

interface LiveSegment {
  id: string
  text: string
  startMs: number
  source: 'mic' | 'system'
}

type Phase = 'setup' | 'live' | 'review'

function newMeetingId(): string {
  return `mtg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function transcriptText(segments: LiveSegment[]): string {
  return segments
    .map((s) => `[${fmtDuration(s.startMs)}] ${s.source === 'mic' ? 'Mic' : 'System'}: ${s.text}`)
    .join('\n')
}

export function MeetingPanel(props: { settings: AppSettings }): React.JSX.Element {
  const { settings } = props
  const [phase, setPhase] = useState<Phase>('setup')
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<'mic' | 'system'>(settings.interview.source)
  const [segments, setSegments] = useState<LiveSegment[]>([])
  const [notes, setNotes] = useState('')
  const [elapsedMs, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'summary' | 'actions' | 'ask' | null>(null)
  const [question, setQuestion] = useState('')
  const [askAnswer, setAskAnswer] = useState('')
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [saved, setSaved] = useState<MeetingSummary[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [openMeeting, setOpenMeeting] = useState<MeetingDetail | null>(null)
  const [status, setStatus] = useState<TranscriptStatusEvent | null>(null)
  const [pausedLocal, setPausedLocal] = useState(false)

  const meetingIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startedAtRef = useRef<number>(0)
  const captureRef = useRef<CaptureSession | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const targetRef = useRef<'notes' | 'ask'>('notes')

  const sttProvider = settings.stt.providers.find((p) => p.id === settings.stt.activeSttProviderId) ?? settings.stt.providers.find((p) => p.enabled)
  const sttLabel = sttProvider ? `${sttProvider.label} · ${sttProvider.model}` : 'no transcription provider configured'
  const language = sttProvider?.language ?? 'en'

  const refreshSaved = useCallback((query = ''): void => {
    const load = query.trim().length > 0
      ? window.copilot.searchMeetings(query.trim())
      : window.copilot.listMeetings()
    void load.then((res) => setSaved(res?.meetings ?? []))
  }, [])
  useEffect(() => { refreshSaved() }, [refreshSaved])

  /* transcript + status subscription (meeting purpose only) */
  useEffect(() => {
    const offSeg = window.copilot.onTranscriptSegment((e: TranscriptSegmentEvent) => {
      if (e.purpose !== 'meeting' || e.sessionId !== sessionIdRef.current) return
      setSegments((prev) => [...prev, { id: e.segmentId, text: e.text, startMs: e.startMs, source: e.source }])
    })
    const offStatus = window.copilot.onTranscriptStatus((e) => {
      if (sessionIdRef.current === e.sessionId || e.state === 'stopped') setStatus(e)
    })
    return () => {
      offSeg()
      offStatus()
    }
  }, [])

  /* elapsed timer while live */
  useEffect(() => {
    if (phase !== 'live') return
    const t = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 500)
    return () => clearInterval(t)
  }, [phase])

  /* generation streaming */
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
      if (e.status === 'completed' && targetRef.current === 'notes') {
        // Persist the generated notes + structured action items.
        const items = parseActionItems(e.text)
        void persistNotes(e.text, items)
      }
    })
    const offError = window.copilot.onModeError((e) => {
      if (e.channel === 'meeting' && e.requestId === requestIdRef.current) {
        setError(e.message)
        setBusy(null)
      }
    })
    return () => {
      offDelta()
      offResult()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persistNotes = useCallback(async (noteText: string, items: MeetingActionItem[]): Promise<void> => {
    const id = meetingIdRef.current
    if (!id) return
    const res = await window.copilot.saveMeeting({
      meetingId: id,
      title: title.trim() || `Meeting ${new Date().toLocaleString()}`,
      transcript: transcriptText(segments),
      notes: noteText,
      actionItems: items,
      source,
      language,
      providerLabel: sttProvider?.label,
      startedAt: new Date(startedAtRef.current).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtRef.current
    })
    if (!res.ok) setError(res.message ?? 'Could not save the meeting.')
    refreshSaved(searchQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, segments, source, language, sttProvider, refreshSaved, searchQuery])

  const saveCurrent = async (): Promise<void> => {
    const id = meetingIdRef.current ?? newMeetingId()
    meetingIdRef.current = id
    const res = await window.copilot.saveMeeting({
      meetingId: id,
      title: title.trim() || `Meeting ${new Date().toLocaleString()}`,
      transcript: transcriptText(segments),
      notes,
      source,
      language,
      providerLabel: sttProvider?.label,
      startedAt: startedAtRef.current ? new Date(startedAtRef.current).toISOString() : undefined,
      endedAt: phase === 'review' ? new Date().toISOString() : undefined,
      durationMs: startedAtRef.current ? (phase === 'review' ? Date.now() - startedAtRef.current : undefined) : undefined
    })
    setExportMsg(res.ok ? 'Meeting saved.' : res.message ?? 'Save failed')
    refreshSaved(searchQuery)
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  const startMeeting = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    const prepared = await window.copilot.prepareTranscript(source, 'meeting')
    if (!prepared.ok || !prepared.sessionId) {
      setError(prepared.message ?? 'Could not start the meeting session.')
      return
    }
    const sessionId = prepared.sessionId
    sessionIdRef.current = sessionId
    meetingIdRef.current = newMeetingId()
    startedAtRef.current = Date.now()
    setSegments([])
    setNotes('')
    setAskAnswer('')
    setElapsed(0)
    setMuted(false)
    setPausedLocal(false)
    setPhase('live')
    window.copilot.beginTranscript(sessionId)
    try {
      captureRef.current = await startCapture(source, undefined, (seq, b64) => {
        if (sessionIdRef.current) window.copilot.sendAudioChunk(sessionIdRef.current, seq, b64)
      })
      captureRef.current.onEnded(() => {
        setError('The audio device disconnected. The meeting was stopped — the transcript so far is kept.')
        void endMeeting(true)
      })
    } catch (err) {
      const message = err instanceof CaptureError ? err.message : 'Could not start audio capture.'
      setError(`${message} You can still generate notes from what was captured.`)
      captureRef.current = null
    }
  }

  const endMeeting = async (deviceLost = false): Promise<void> => {
    captureRef.current?.stop()
    captureRef.current = null
    const sessionId = sessionIdRef.current
    if (sessionId) window.copilot.stopTranscript(sessionId)
    sessionIdRef.current = null
    setStatus(null)
    setPhase('review')
    if (deviceLost) return
    // Auto-summary: the brief requires the summary to generate on end.
    await run('summary')
  }

  const abortMeeting = (): void => {
    captureRef.current?.stop()
    captureRef.current = null
    const sessionId = sessionIdRef.current
    if (sessionId) window.copilot.stopTranscript(sessionId)
    sessionIdRef.current = null
    meetingIdRef.current = null
    setPhase('setup')
    setStatus(null)
  }

  /* ── generation ─────────────────────────────────────────────────────── */

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
    // A saved meeting answers from ITS transcript; a live one from the session.
    const req = openMeeting && phase === 'review' && openMeeting.meetingId !== meetingIdRef.current
      ? { question: question.trim(), meetingId: openMeeting.meetingId }
      : { question: question.trim() }
    const res = await window.copilot.askMeeting(req)
    if (res.ok && res.requestId) requestIdRef.current = res.requestId
    else {
      setError(res.message ?? 'Could not ask.')
      setBusy(null)
    }
  }

  const stopGeneration = (): void => window.copilot.cancelMeeting()

  const exportNotes = async (format: 'markdown' | 'txt'): Promise<void> => {
    if (!notes.trim()) return
    setExportMsg(null)
    const res = await window.copilot.exportNotes({ content: notes, format })
    if (res.ok) setExportMsg('Saved.')
    else if (res.canceled) setExportMsg(null)
    else setError(res.message ?? 'Export failed.')
  }

  /* ── saved meetings ─────────────────────────────────────────────────── */

  const openSaved = async (m: MeetingSummary): Promise<void> => {
    const detail = await window.copilot.getMeeting(m.meetingId)
    if (!detail) {
      setError('Could not open this meeting.')
      return
    }
    meetingIdRef.current = m.meetingId
    setOpenMeeting(detail)
    setTitle(detail.title)
    setNotes(detail.notes)
    setSegments(
      detail.transcript
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l, i) => {
          const timeM = l.match(/^\[(\d+:\d+)\]\s*(Mic|System)?:\s*(.*)$/)
          return {
            id: `saved-${i}`,
            text: timeM ? timeM[3] : l,
            startMs: timeM ? (Number(timeM[1].split(':')[0]) * 60 + Number(timeM[1].split(':')[1])) * 1000 : 0,
            source: timeM && timeM[2] === 'System' ? ('system' as const) : ('mic' as const)
          }
        })
    )
    setPhase('review')
    setError(null)
    setNotice(null)
    setAskAnswer('')
  }

  const deleteSaved = async (m: MeetingSummary): Promise<void> => {
    await window.copilot.deleteMeeting(m.meetingId)
    if (openMeeting?.meetingId === m.meetingId) {
      setOpenMeeting(null)
      setPhase('setup')
    }
    refreshSaved(searchQuery)
  }

  const newMeeting = (): void => {
    meetingIdRef.current = null
    setOpenMeeting(null)
    setTitle('')
    setNotes('')
    setSegments([])
    setAskAnswer('')
    setPhase('setup')
    setError(null)
    setNotice(null)
    setExportMsg(null)
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  const listening = status?.state === 'listening' && phase === 'live'
  const paused = pausedLocal || status?.state === 'paused'

  return (
    <>
      {phase === 'setup' && (
        <>
          <div className="card">
            <div className="section-title">New meeting</div>
            <div className="row">
              <input
                className="grow"
                type="text"
                placeholder="Meeting title (e.g. Sprint planning with design)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void startMeeting()}
              />
            </div>
            <div className="row">
              <label>Audio</label>
              <select value={source} onChange={(e) => setSource(e.target.value as 'mic' | 'system')}>
                <option value="mic">Microphone</option>
                <option value="system">System audio (loopback)</option>
              </select>
              <label>Language</label>
              <span className="badge">{language}</span>
            </div>
            <div className="hint">Transcription provider: {sttLabel}</div>
            <div className="row">
              <button className="primary" onClick={() => void startMeeting()}>
                ▶ Start meeting
              </button>
            </div>
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>

          <div className="card">
            <div className="section-title">Saved meetings</div>
            <div className="row">
              <input
                className="grow"
                type="search"
                placeholder="Search titles, notes and transcripts…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  refreshSaved(e.target.value)
                }}
              />
            </div>
            {saved.length === 0 ? (
              <div className="hint">{searchQuery ? 'No meetings match this search.' : 'No saved meetings yet.'}</div>
            ) : (
              <div className="mt-list">
                {saved.map((m) => (
                  <div key={m.meetingId} className="row" style={{ gap: 6 }}>
                    <button className="mt-item grow" onClick={() => void openSaved(m)} title="Open this meeting">
                      <span className="mt-title grow">{m.title}</span>
                      <span className="mt-meta">
                        {m.durationMs ? fmtDuration(m.durationMs) + ' · ' : ''}
                        {m.actionItemCount ? `${m.actionItemCount} actions · ` : ''}
                        {shortTime(m.updatedAt)}
                      </span>
                    </button>
                    <button className="meta-btn" title="Delete this meeting" onClick={() => void deleteSaved(m)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {phase === 'live' && (
        <>
          <div className="iv-session">
            <span className={`dot ${listening ? 'rec' : paused ? 'paused' : ''}`} />
            <span className="iv-status">Recording{paused ? ' · paused' : ''}</span>
            <span className="badge">{fmtDuration(elapsedMs)}</span>
            {muted && <span className="badge warn">muted</span>}
            <span className="grow" />
            <button className="chip" onClick={() => { window.copilot.pauseTranscript(sessionIdRef.current ?? ''); setPausedLocal(true) }} disabled={paused}>
              Pause
            </button>
            <button className="chip" onClick={() => { window.copilot.resumeTranscript(sessionIdRef.current ?? ''); setPausedLocal(false) }} disabled={!paused}>
              Resume
            </button>
            <button className="chip" onClick={() => { const next = !muted; setMuted(next); window.copilot.muteTranscript(sessionIdRef.current ?? '', next) }}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="chip" onClick={() => void endMeeting()} title="End the meeting and generate notes">
              ■ End meeting
            </button>
            <button className="meta-btn" onClick={abortMeeting} title="Discard without saving">
              discard
            </button>
          </div>

          {error && <ErrorBox>{error}</ErrorBox>}

          <div>
            <div className="iv-label" style={{ marginBottom: 6 }}>
              Live transcript · {segments.length} segment{segments.length === 1 ? '' : 's'} · Mic = you, System = other audio
            </div>
            <div className="mt-transcript">
              {segments.length === 0 && <div className="hint">Speak — finalized sentences appear here with timestamps.</div>}
              {segments.map((s) => (
                <div key={s.id} className="mt-seg">
                  <span className="seg-time">{fmtDuration(s.startMs)}</span>
                  <span className="badge" style={{ marginRight: 6 }}>{s.source === 'mic' ? 'Mic' : 'System'}</span>
                  {s.text}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {phase === 'review' && (
        <>
          <div className="iv-session">
            <span className="dot live" />
            <span className="iv-status">{openMeeting ? 'Saved meeting' : 'Meeting notes'}</span>
            {openMeeting?.durationMs ? <span className="badge">{fmtDuration(openMeeting.durationMs)}</span> : null}
            {openMeeting?.language && <span className="badge">{openMeeting.language}</span>}
            {openMeeting?.providerLabel && <span className="badge">{openMeeting.providerLabel}</span>}
            <span className="grow" />
            <button className="chip" onClick={newMeeting}>+ New meeting</button>
          </div>

          {error && <ErrorBox>{error}</ErrorBox>}
          {notice && <NoticeBox>{notice}</NoticeBox>}

          <div className="row wrap">
            <button className="secondary" disabled={!!busy} onClick={() => void run('summary')}>
              Summarize
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => void run('actions')}>
              Extract action items
            </button>
            <button className="secondary" disabled={!notes.trim()} onClick={() => void saveCurrent()}>
              Save
            </button>
            <button className="secondary" disabled={!notes.trim()} onClick={() => void exportNotes('markdown')}>
              Export MD
            </button>
            <button className="secondary" disabled={!notes.trim()} onClick={() => void exportNotes('txt')}>
              Export TXT
            </button>
            {busy && <span className="badge accent">generating…</span>}
          </div>

          {segments.length > 0 && (
            <div>
              <div className="iv-label" style={{ marginBottom: 6 }}>Transcript</div>
              <div className="mt-transcript">
                {segments.map((s) => (
                  <div key={s.id} className="mt-seg">
                    <span className="seg-time">{fmtDuration(s.startMs)}</span>
                    <span className="badge" style={{ marginRight: 6 }}>{s.source === 'mic' ? 'Mic' : 'System'}</span>
                    {s.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="iv-label" style={{ marginBottom: 6 }}>Notes (editable)</div>
            <textarea
              className="notes-editor"
              value={notes}
              placeholder="Generated meeting notes appear here and stay fully editable before saving or exporting."
              onChange={(e) => setNotes(e.target.value)}
            />
            {exportMsg && <div className="hint" style={{ marginTop: 4 }}>{exportMsg}</div>}
          </div>

          <div className="row">
            <input
              className="grow"
              type="text"
              value={question}
              placeholder={openMeeting ? `Ask about “${openMeeting.title}”…` : 'Ask about this meeting…'}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void ask()}
            />
            {busy === 'ask' ? (
              <button className="secondary" onClick={stopGeneration}>Stop</button>
            ) : (
              <button className="primary" disabled={!question.trim() || !!busy} onClick={() => void ask()}>Ask</button>
            )}
          </div>
          {askAnswer && <div className="bubble assistant">{askAnswer}</div>}
        </>
      )}
    </>
  )
}
