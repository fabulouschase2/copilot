import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AnswerStyle,
  AppSettings,
  InterviewSettings,
  ModeQuestion,
  ModeResultEvent,
  TranscriptStatusEvent
} from '../../shared/protocol'
import { renderAnswer } from './answerRender'

const STYLES: Array<{ id: AnswerStyle; label: string }> = [
  { id: 'star', label: 'Behavioral' },
  { id: 'coding', label: 'Coding' },
  { id: 'research', label: 'Research' },
  { id: 'concise', label: 'Concise' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'technical', label: 'Technical' }
]

/**
 * Interview view — the primary workflow:
 * Interviewer (recognized/typed question) → Your Answer (streamed, refineable).
 * Lifecycle: Idle → Start interview → Listening → Question detected →
 * waiting (configured delay) → Generating → Displayed.
 */
export function InterviewPanel(props: {
  settings: AppSettings
  screenTrigger: number
}): React.JSX.Element {
  const { settings, screenTrigger } = props
  const iv: InterviewSettings = settings.interview

  const [status, setStatus] = useState<TranscriptStatusEvent | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [style, setStyle] = useState<AnswerStyle>('star')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModeResultEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [segments, setSegments] = useState<Array<{ id: string; text: string }>>([])
  const [showTranscript, setShowTranscript] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const listening = status?.state === 'listening'
  const inSession = status !== null && status.state !== 'stopped'

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
    return () => {
      offDelta()
      offResult()
      offError()
      offStatus()
    }
  }, [])

  useEffect(() => {
    return window.copilot.onTranscriptSegment((e) => {
      setSegments((prev) => [{ id: e.segmentId, text: e.text }, ...prev].slice(0, 30))
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
      const res = await window.copilot.answerInterview({ question: q, style, includeSession: listening })
      if (res.ok && res.requestId) requestIdRef.current = res.requestId
      else {
        setError(res.message ?? 'Could not start generation.')
        setBusy(false)
      }
    },
    [busy, style, listening, cancelAutoAnswer]
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
  const startInterview = useCallback(async (): Promise<void> => {
    setError(null)
    const prepared = await window.copilot.prepareTranscript(iv.source)
    if (!prepared.ok || !prepared.sessionId) {
      setError(
        prepared.message ??
          'Live listening needs a transcription provider (Setup → Listening). You can still type questions manually.'
      )
      return
    }
    sessionIdRef.current = prepared.sessionId
    window.copilot.beginTranscript(prepared.sessionId)
  }, [iv.source])

  const endInterview = useCallback((): void => {
    cancelAutoAnswer()
    const sessionId = sessionIdRef.current
    if (sessionId) window.copilot.stopTranscript(sessionId)
    sessionIdRef.current = null
    setStatus(null)
    setSegments([])
  }, [cancelAutoAnswer])

  /* ── detected questions: fill Interviewer + optional auto-answer ────── */
  useEffect(() => {
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

  /* ── screen read (header button / global shortcut) ───────────────────── */
  const readScreenRef = useRef<() => Promise<void>>(async () => undefined)
  const readScreen = useCallback(async (): Promise<void> => {
    if (busy) return
    setError(null)
    setNotice(null)
    setAnswer('')
    setResult(null)
    setBusy(true)
    await window.copilot.armScreen(true)
    const res = await window.copilot.analyzeScreen({
      kind: 'screen',
      question: `Read the visible screen for interview context. If an interview or coding question is visible, state it verbatim, then answer it in ${
        style === 'coding' ? 'working code with complexity' : 'a concise, structured way'
      }.`,
      includeTranscript: false,
      includeContext: true
    })
    if (res.ok && res.requestId) {
      requestIdRef.current = res.requestId
      setNotice('Screen read running — the capture window is visible.')
    } else {
      setError(res.message ?? 'Screen read failed.')
      setBusy(false)
    }
  }, [busy, style])
  readScreenRef.current = readScreen

  useEffect(() => {
    if (screenTrigger > 0) void readScreenRef.current()
  }, [screenTrigger])

  /* ── triggers + in-app shortcut registry ────────────────────────────── */
  useEffect(() => {
    return window.copilot.onAppTrigger((e) => {
      if (e.action === 'read-screen') void readScreenRef.current()
      if (e.action === 'end-session') endInterview()
    })
  }, [endInterview])

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
        ? 'Interview'
        : 'Idle'

  return (
    <div className="iv2">
      <div className="iv2-session">
        <span className={`dot ${listening ? 'rec' : ''}`} />
        <span className="iv2-status">{statusLabel}</span>
        {countdown !== null && <span className="badge ok">Answering in {countdown}s…</span>}
        <span className="grow" />
        {inSession ? (
          <button className="chip" onClick={endInterview}>
            End interview
          </button>
        ) : (
          <button className="chip" onClick={() => void startInterview()}>
            Start interview
          </button>
        )}
      </div>

      <div className="iv2-section">
        <div className="iv2-label">
          Interviewer
          {segments.length > 0 && (
            <button className="meta-btn" onClick={() => setShowTranscript((v) => !v)}>
              {showTranscript ? 'hide transcript' : `transcript (${segments.length})`}
            </button>
          )}
        </div>
        <textarea
          className="iv2-question"
          value={question}
          placeholder="Recognized questions appear here — or type one."
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
          <div className="iv2-transcript">
            {segments.length === 0 && <div className="hint">No transcript yet in this session.</div>}
            {segments.map((s) => (
              <button key={s.id} className="iv2-seg" onClick={() => setQuestion(s.text)} title="Use as question">
                {s.text}
              </button>
            ))}
          </div>
        )}
        <div className="iv2-actions">
          {busy ? (
            <button className="primary" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button className="primary" disabled={!question.trim()} onClick={() => void generate(question)}>
              Answer now
            </button>
          )}
          <button className="chip" onClick={clearQA} disabled={!question && !answer}>
            Clear
          </button>
          <span className="grow" />
          {listening && iv.autoAnswer && countdown === null && (
            <span className="hint">Auto-answer after {iv.delaySeconds}s pause</span>
          )}
        </div>
      </div>

      <div className="iv2-section iv2-answer-section">
        <div className="iv2-label">Your Answer</div>
        {error && <div className="error-text iv2-error">{error}</div>}
        {notice && <div className="hint">{notice}</div>}
        <div className="iv2-answer" aria-live="polite">
          {answer ? (
            renderAnswer(answer)
          ) : busy ? (
            <span className="hint">Generating…</span>
          ) : result?.status === 'cancelled' ? (
            <span className="hint">Stopped.</span>
          ) : (
            <span className="hint">
              The answer streams here. Coding answers keep code formatting; sources are listed below.
            </span>
          )}
        </div>
        {result && result.contextUsed.length > 0 && (
          <div className="iv2-sources">
            {result.contextUsed.map((c) => (
              <span key={c.sourceId} className="badge">
                {c.displayName} {Math.round(c.score * 100)}%
              </span>
            ))}
          </div>
        )}
        {result && result.evidenceLevel && result.evidenceLevel !== 'good' && result.status === 'completed' && (
          <div className="iv2-warning">
            ⚠{' '}
            {result.evidenceLevel === 'none'
              ? 'No supporting evidence in your resume/profile — general guidance, not your experience.'
              : 'Limited supporting evidence — verify specific claims.'}
          </div>
        )}
        <div className="iv2-answer-actions">
          <button className="chip" disabled={!answer} onClick={() => void navigator.clipboard.writeText(answer)}>
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
        </div>
      </div>

      <div className="iv2-styles">
        {STYLES.map((s) => (
          <button
            key={s.id}
            className={`pill ${style === s.id ? 'pill-active' : ''}`}
            onClick={() => setStyle(s.id)}
            disabled={busy}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
