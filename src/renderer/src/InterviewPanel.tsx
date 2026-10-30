import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AnswerStyle,
  AppSettings,
  InterviewSettings,
  ModeQuestion,
  ModeResultEvent,
  TranscriptSource,
  TranscriptStatusEvent
} from '../../shared/protocol'
import { renderAnswer } from './answerRender'
import { startCapture, CaptureSession, CaptureError } from './audio/capture'
import { ErrorBox, NoticeBox } from './ui'

/**
 * Interview view — the primary workflow:
 * session controls → Interviewer (recognized/typed question, live transcript)
 * → Your Answer (streamed, refineable). Modes are grouped Research /
 * Behavioral / Coding; answer length is a separate control. Everything here
 * reuses the existing answer-generation services and IPC contracts.
 *
 * AUDIO CONTRACT (regression-critical): the renderer is the sensor. Start
 * interview MUST start renderer capture (startCapture) and stream PCM chunks
 * to the main process — prepare/begin alone leave the session "listening"
 * with zero audio flowing (this exact bug shipped once: status showed
 * Listening while nothing was ever captured). tests/renderer-contracts.test.ts
 * pins this.
 */

const MODES: Array<{ id: AnswerStyle; label: string; group: string }> = [
  { id: 'research', label: 'Research', group: 'Research' },
  { id: 'star', label: 'Behavioral (STAR)', group: 'Behavioral' },
  { id: 'coding', label: 'Coding', group: 'Coding' },
  { id: 'technical', label: 'Technical', group: 'More' },
  { id: 'concise', label: 'Concise', group: 'More' },
  { id: 'detailed', label: 'Detailed', group: 'More' }
]

interface Segment {
  id: string
  text: string
  wallTime: string
}

export function InterviewPanel(props: {
  settings: AppSettings
  onOpenScreenRead: () => void
  onOpenDiagnostics?: () => void
  onChangeSettings: (s: AppSettings) => void
}): React.JSX.Element {
  const { settings, onOpenScreenRead, onOpenDiagnostics, onChangeSettings } = props
  const iv: InterviewSettings = settings.interview

  const [status, setStatus] = useState<TranscriptStatusEvent | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [mode, setMode] = useState<AnswerStyle>('star')
  const [detail, setDetail] = useState<'concise' | 'detailed'>('concise')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModeResultEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [showTranscript, setShowTranscript] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const captureRef = useRef<CaptureSession | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const listening = status?.state === 'listening'
  const inSession = status !== null && status.state !== 'stopped'
  const liveSource: TranscriptSource | null = status?.source ?? null

  /* ── streaming subscriptions ─────────────────────────────────────────── */
  useEffect(() => {
    const offDelta = window.copilot.onModeDelta((e) => {
      if (e.channel === 'interview' && e.requestId === requestIdRef.current) setAnswer((p) => p + e.delta)
    })
    const offResult = window.copilot.onModeResult((e) => {
      if (e.channel !== 'interview' || e.requestId !== requestIdRef.current) return
      setResult(e)
      setBusy(false)
      if (e.status === 'error') setError(e.message ?? 'Generation failed.')
      if (e.status === 'cancelled') setNotice('Generation stopped.')
    })
    const offError = window.copilot.onModeError((e) => {
      if (e.channel === 'interview' && e.requestId === requestIdRef.current) setError(e.message)
    })
    const offStatus = window.copilot.onTranscriptStatus((e) => {
      if (sessionIdRef.current === e.sessionId || e.state === 'stopped') setStatus(e)
    })
    const offTrigger = window.copilot.onAppTrigger((e) => {
      if (e.action === 'end-session') endInterviewRef.current()
      if (e.action === 'read-screen') onOpenScreenRead()
    })
    // Audio pipeline errors (permission, device, STT) must never be silent.
    const offTranscriptError = window.copilot.onTranscriptError((e) => {
      if (sessionIdRef.current && e.sessionId !== sessionIdRef.current) return
      setError(
        e.code === 'stt'
          ? `Transcription failed: ${e.message} Check the transcription provider in Settings → Providers.`
          : e.code === 'permission'
            ? `Audio permission was denied: ${e.message}`
            : e.code === 'device'
              ? `Audio device problem: ${e.message}`
              : e.message
      )
    })
    return () => {
      offDelta()
      offResult()
      offError()
      offStatus()
      offTrigger()
      offTranscriptError()
    }
  }, [onOpenScreenRead])

  useEffect(() => {
    return window.copilot.onTranscriptSegment((e) => {
      if (e.purpose !== 'interview') return
      setSegments((prev) => [{ id: e.segmentId, text: e.text, wallTime: e.wallTime }, ...prev].slice(0, 30))
    })
  }, [])

  /* ── auto-answer timer management ────────────────────────────────────── */
  const cancelAutoAnswer = useCallback((): void => {
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = null
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = null
    setCountdown(null)
  }, [])

  /* ── generation ─────────────────────────────────────────────────────── */
  const generateRef = useRef<(q: string) => Promise<void>>(async () => undefined)
  const generate = useCallback(
    async (rawQuestion: string): Promise<void> => {
      const q = rawQuestion.trim()
      if (!q || busy) return
      cancelAutoAnswer()
      setError(null)
      setNotice(null)
      setAnswer('')
      setResult(null)
      setBusy(true)
      const res = await window.copilot.answerInterview({ question: q, style: mode, detail, includeSession: listening })
      if (res.ok && res.requestId) requestIdRef.current = res.requestId
      else {
        setError(res.message ?? 'Could not start generation.')
        setBusy(false)
      }
    },
    [busy, mode, detail, listening, cancelAutoAnswer]
  )
  generateRef.current = generate

  const stop = (): void => {
    cancelAutoAnswer()
    window.copilot.cancelInterview()
  }

  const clearQA = useCallback((): void => {
    setQuestion('')
    setAnswer('')
    setResult(null)
    setError(null)
    setNotice(null)
    requestIdRef.current = null
  }, [])

  const refine = async (kind: 'shorter' | 'rephrase'): Promise<void> => {
    if (busy || !answer.trim() || !question.trim()) return
    setError(null)
    setNotice(null)
    setAnswer('')
    setResult(null)
    setBusy(true)
    const res = await window.copilot.refineInterview({
      kind,
      question: question.trim(),
      previousAnswer: result?.text ?? ''
    })
    if (res.ok && res.requestId) requestIdRef.current = res.requestId
    else {
      setError(res.message ?? 'Could not refine.')
      setBusy(false)
    }
  }

  /* ── session lifecycle ──────────────────────────────────────────────── */
  const endInterviewRef = useRef<() => void>(() => undefined)

  /** Source switch (idle only): persists via the shared settings contract. */
  const onChangeSource = (source: TranscriptSource): void => {
    onChangeSettings({ ...settings, interview: { ...iv, source } })
  }

  const startInterview = useCallback(async (): Promise<void> => {
    setError(null)
    setNotice(null)
    const prepared = await window.copilot.prepareTranscript(iv.source, 'interview')
    if (!prepared.ok || !prepared.sessionId) {
      setError(
        prepared.message ??
          'Live listening needs a transcription provider (Settings → Providers). You can still type questions manually.'
      )
      return
    }
    const sessionId = prepared.sessionId
    sessionIdRef.current = sessionId
    window.copilot.beginTranscript(sessionId)
    // THE SENSOR: the renderer acquires the OS stream and streams PCM chunks
    // to the main process. Without this the session sits "listening" with no
    // audio (the shipped v0.2.0 bug). Status/segments/error events above take
    // over from here.
    try {
      captureRef.current = await startCapture(iv.source, undefined, (seq, b64) => {
        if (sessionIdRef.current) window.copilot.sendAudioChunk(sessionIdRef.current, seq, b64)
      })
      captureRef.current.onEnded(() => {
        setError(
          iv.source === 'mic'
            ? 'The microphone was disconnected. The session was stopped.'
            : 'The system-audio capture ended (the source stream stopped). The session was stopped.'
        )
        endInterviewRef.current()
      })
      setNotice(
        iv.source === 'mic'
          ? 'Listening to the microphone. Play or speak the interview audio through the computer for System audio instead.'
          : 'Listening to system audio (everything the computer plays). Use the microphone selector for your own voice.'
      )
    } catch (err) {
      const message = err instanceof CaptureError ? err.message : 'Could not start audio capture.'
      setError(
        iv.source === 'system'
          ? `${message} System audio needs Windows loopback; try again or use the microphone.`
          : message
      )
      window.copilot.stopTranscript(sessionId)
      sessionIdRef.current = null
      setStatus(null)
    }
  }, [iv.source])

  const endInterview = useCallback((): void => {
    cancelAutoAnswer()
    captureRef.current?.stop()
    captureRef.current = null
    const sessionId = sessionIdRef.current
    if (sessionId) window.copilot.stopTranscript(sessionId)
    sessionIdRef.current = null
    setStatus(null)
    setSegments([])
    setShowTranscript(false)
  }, [cancelAutoAnswer])
  endInterviewRef.current = endInterview

  /* ── detected questions: fill Interviewer + optional auto-answer ────── */  useEffect(() => {
    return window.copilot.onModeQuestion((q: ModeQuestion) => {
      setQuestion(q.text)
      if (!iv.autoAnswer || !listening || busy) return
      cancelAutoAnswer()
      let remaining = iv.delaySeconds
      setCountdown(remaining)
      countdownRef.current = setInterval(() => {
        setCountdown((c) => (c === null ? null : Math.max(0, c - 1)))
      }, 1_000)
      autoTimerRef.current = setTimeout(() => {
        cancelAutoAnswer()
        void generateRef.current(q.text)
      }, remaining * 1_000)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv.autoAnswer, iv.delaySeconds, listening, busy, cancelAutoAnswer])

  useEffect(() => () => cancelAutoAnswer(), [cancelAutoAnswer])

  /* ── keyboard shortcuts (registry-verified in-app chords) ───────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const parts: string[] = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      if (e.metaKey) parts.push('meta')
      parts.push(e.key.toLowerCase())
      const chord = parts.join('+')
      if (chord === 'ctrl+enter') {
        e.preventDefault()
        void generateRef.current(question)
      } else if (chord === 'escape' && busy) {
        e.preventDefault()
        stop()
      } else if (chord === 'ctrl+shift+arrowdown' && result?.status === 'completed') {
        e.preventDefault()
        void refine('shorter')
      } else if (chord === 'ctrl+shift+arrowup' && result?.status === 'completed') {
        e.preventDefault()
        void refine('rephrase')
      } else if (chord === 'ctrl+shift+c' && answer) {
        e.preventDefault()
        void navigator.clipboard.writeText(answer)
      } else if (chord === 'ctrl+shift+backspace') {
        e.preventDefault()
        clearQA()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [question, busy, result, answer, refine, clearQA])

  /* ── render ─────────────────────────────────────────────────────────── */
  const statusLabel = listening
    ? 'Interview · Listening'
    : status?.state === 'paused'
      ? 'Interview · Paused'
      : inSession
        ? 'Interview session'
        : 'Idle'

  const groupLabel = mode === 'research' ? 'Research' : mode === 'star' ? 'Behavioral' : mode === 'coding' ? 'Coding' : 'More'

  return (
    <>
      <div className="iv-session">
        <span className={`dot ${listening ? (status?.speechActive ? 'rec' : 'live') : ''}`} />
        <span className="iv-status">
          {statusLabel}
          {listening && status?.speechActive ? ' · hearing speech' : listening ? ' · silent' : ''}
        </span>
        {inSession && liveSource && (
          <span className="badge accent">
            {liveSource === 'mic' ? 'Microphone' : 'System audio'}
          </span>
        )}
        {countdown !== null && <span className="badge accent">Answering in {countdown}s…</span>}
        <span className="grow" />
        {!inSession && (
          <select
            value={iv.source}
            onChange={(e) => onChangeSource(e.target.value as TranscriptSource)}
            title="Which audio to listen to"
          >
            <option value="mic">Microphone</option>
            <option value="system">System audio</option>
          </select>
        )}
        {onOpenDiagnostics && (
          <button className="chip" onClick={onOpenDiagnostics} title="Audio diagnostics">
            🎚
          </button>
        )}
        {inSession ? (
          <button className="chip" onClick={endInterview}>
            End interview
          </button>
        ) : (
          <button className="chip" onClick={() => void startInterview()}>
            ▶ Start interview
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="iv-label">
          Interviewer
          {segments.length > 0 && (
            <button className="meta-btn" onClick={() => setShowTranscript((v) => !v)}>
              {showTranscript ? 'hide transcript' : `live transcript (${segments.length})`}
            </button>
          )}
        </div>
        <textarea
          className="iv-question"
          value={question}
          placeholder="Recognized questions appear here — or type one (Ctrl+Enter to answer)."
          onChange={(e) => {
            setQuestion(e.target.value)
            cancelAutoAnswer()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              void generateRef.current(question)
            }
          }}
        />
        {showTranscript && (
          <div className="iv-transcript">
            {segments.length === 0 && <div className="hint">No transcript yet in this session.</div>}
            {segments.map((s) => (
              <button key={s.id} className="iv-seg" onClick={() => { setQuestion(s.text); cancelAutoAnswer() }} title="Use as question">
                <span className="seg-time">{new Date(s.wallTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                {s.text}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          {busy ? (
            <button className="primary" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button className="primary" disabled={!question.trim()} onClick={() => void generate(question)}>
              Answer now
            </button>
          )}
          <button className="ghost" onClick={clearQA} disabled={!question && !answer}>
            Clear
          </button>
          <span className="grow" />
          <button className="chip" onClick={onOpenScreenRead} title="Read the current screen (Ctrl+Alt+R)">
            🖥 Read screen
          </button>
        </div>
        {listening && iv.autoAnswer && countdown === null && (
          <div className="hint">Auto-answer arms {iv.delaySeconds}s after a detected question finishes.</div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="iv-label">Your Answer</div>
        {error && <ErrorBox>{error}</ErrorBox>}
        {notice && <NoticeBox>{notice}</NoticeBox>}
        <div className="iv-answer" aria-live="polite">
          {answer ? (
            <>
              {renderAnswer(answer)}
              {busy && <span className="stream-cursor" />}
            </>
          ) : busy ? (
            <span className="hint">Generating…</span>
          ) : result?.status === 'cancelled' ? (
            <span className="hint">Stopped.</span>
          ) : (
            <span className="hint">
              The answer streams here. Coding answers keep code formatting; sources used are listed below.
            </span>
          )}
        </div>
        {result && result.contextUsed.length > 0 && (
          <div className="iv-sources">
            {result.contextUsed.map((c) => (
              <span key={c.sourceId} className="badge">
                {c.displayName} {Math.round(c.score * 100)}%
              </span>
            ))}
          </div>
        )}
        {result && result.evidenceLevel && result.evidenceLevel !== 'good' && result.status === 'completed' && (
          <div className="iv-warning">
            ⚠{' '}
            {result.evidenceLevel === 'none'
              ? 'No supporting evidence in your resume/profile — this is general guidance, not your experience.'
              : 'Limited supporting evidence — verify specific claims before relying on them.'}
          </div>
        )}
        <div className="answer-meta">
          <button className="chip" disabled={!answer} onClick={() => void navigator.clipboard.writeText(answer)} title="Ctrl+Shift+C">
            Copy
          </button>
          <button
            className="chip"
            disabled={busy || !result || result.status !== 'completed'}
            onClick={() => void refine('shorter')}
            title="Ctrl+Shift+↓"
          >
            Shorter
          </button>
          <button
            className="chip"
            disabled={busy || !result || result.status !== 'completed'}
            onClick={() => void refine('rephrase')}
            title="Ctrl+Shift+↑"
          >
            Rephrase
          </button>
          <button className="chip" disabled={busy || !question.trim()} onClick={() => void generate(question)}>
            Regenerate
          </button>
          {result?.usage && (result.usage.inputTokens !== null || result.usage.outputTokens !== null) && (
            <span className="badge">
              ≈{[result.usage.inputTokens, result.usage.outputTokens].filter((n) => n !== null).join(' + ')} tokens
            </span>
          )}
        </div>
      </div>

      <div className="iv-styles">
        <span className="style-group-label">Mode: {groupLabel}</span>
        {MODES.map((s) => (
          <button
            key={s.id}
            className={`pill ${mode === s.id ? 'pill-active' : ''}`}
            onClick={() => setMode(s.id)}
            disabled={busy}
          >
            {s.label}
          </button>
        ))}
        <span className="style-group-label">Length</span>
        <button className={`pill ${detail === 'concise' ? 'pill-active' : ''}`} onClick={() => setDetail('concise')} disabled={busy}>
          Concise
        </button>
        <button className={`pill ${detail === 'detailed' ? 'pill-active' : ''}`} onClick={() => setDetail('detailed')} disabled={busy}>
          Detailed
        </button>
      </div>
    </>
  )
}
