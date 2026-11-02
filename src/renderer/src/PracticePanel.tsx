import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  PracticeDetail,
  PracticeDifficulty,
  PracticeFeedback,
  PracticeSessionInfo,
  PracticeType
} from '../../shared/protocol'
import { startCapture, CaptureSession, CaptureError } from './audio/capture'
import { speak, stopSpeaking, ttsSupported } from './speak'
import { ErrorBox, LoadingRow, ScoreRow, shortTime } from './ui'

/**
 * Practice — a dedicated mock-interview system (transformation rebuild).
 * Setup (type · difficulty · length · JD · profile) → live interview
 * (one question at a time, read-aloud TTS, typed or spoken answers,
 * rubric evaluation after every answer) → scorecard (overall + dimensions +
 * areas to improve + per-turn review with suggested improved answers).
 * Practice sessions are fully separate from live interviews and meetings.
 */

const TYPES: Array<{ id: PracticeType; name: string; desc: string }> = [
  { id: 'behavioral', name: 'Behavioral', desc: '“Tell me about a time…” — STAR past experience' },
  { id: 'technical', name: 'Technical', desc: 'Role knowledge and fundamentals' },
  { id: 'software-engineering', name: 'Software engineering', desc: 'Design, debugging, testing, collaboration' },
  { id: 'coding', name: 'Coding', desc: 'One concrete coding problem per turn' },
  { id: 'system-design', name: 'System design', desc: 'Architecture, scale, trade-offs' },
  { id: 'ai-evaluation', name: 'AI / QA evaluation', desc: 'Metrics, rubrics, datasets, review' },
  { id: 'custom', name: 'Custom', desc: 'Your own focus and job description' }
]

const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.id, t.name]))

type Phase = 'setup' | 'live' | 'done' | 'review'

export function PracticePanel(props: { settings: AppSettings }): React.JSX.Element {
  const { settings } = props
  const [phase, setPhase] = useState<Phase>('setup')
  const [type, setType] = useState<PracticeType>('behavioral')
  const [difficulty, setDifficulty] = useState<PracticeDifficulty>('medium')
  const [questionCount, setQuestionCount] = useState(5)
  const [role, setRole] = useState('')
  const [jd, setJd] = useState('')
  const [customFocus, setCustomFocus] = useState('')
  const [autoSpeak, setAutoSpeak] = useState(true)
  const [speaking, setSpeaking] = useState(false)

  const [index, setIndex] = useState(0)
  const [question, setQuestion] = useState('')
  const [questionStreaming, setQuestionStreaming] = useState(false)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<PracticeFeedback | null>(null)
  /** True from Submit until the evaluation event arrives (covers silent providers). */
  const [awaitingEval, setAwaitingEval] = useState(false)
  /** Feedback of the PREVIOUS answer, kept readable while the next question loads. */
  const [previousFeedback, setPreviousFeedback] = useState<{ index: number; feedback: PracticeFeedback } | null>(null)
  const [evalStreaming, setEvalStreaming] = useState(false)
  const [scorecard, setScorecard] = useState<PracticeDetail['scorecard']>(undefined)
  const [turns, setTurns] = useState<PracticeDetail['turns']>([])
  const [sessionInfo, setSessionInfo] = useState<PracticeSessionInfo | null>(null)

  const [micOn, setMicOn] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<PracticeSessionInfo[] | null>(null)
  const [detail, setDetail] = useState<PracticeDetail | null>(null)

  const practiceIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const captureRef = useRef<CaptureSession | null>(null)
  const speakHandleRef = useRef<{ cancel(): void } | null>(null)
  const answerRef = useRef('')
  const lastQuestionReqRef = useRef<string | null>(null)
  const questionStreamingRef = useRef(false)

  answerRef.current = answer

  const refreshHistory = useCallback((): void => {
    void window.copilot.listPractice().then((res) => setHistory(res.sessions))
  }, [])
  useEffect(() => { refreshHistory() }, [refreshHistory])

  /* ── practice event subscription ────────────────────────────────────── */
  useEffect(() => {
    const offDelta = window.copilot.onPracticeDelta((e) => {
      if (e.practiceId !== practiceIdRef.current) return
      if (e.kind === 'question') {
        questionStreamingRef.current = true
        setQuestionStreaming(true)
        // A new requestId starts a new question: reset the buffer.
        if (lastQuestionReqRef.current !== e.requestId) {
          lastQuestionReqRef.current = e.requestId
          setQuestion(e.delta)
        } else {
          setQuestion((p) => p + e.delta)
        }
      } else if (e.kind === 'eval') {
        setEvalStreaming(true)
      }
    })
    const offQuestion = window.copilot.onPracticeQuestion((e) => {
      if (e.practiceId !== practiceIdRef.current) return
      setIndex(e.index)
      setQuestion(e.question)
      questionStreamingRef.current = false
      setQuestionStreaming(false)
      setEvalStreaming(false)
      // Keep the last evaluation readable while the next question loads —
      // wiping it on arrival left no time to act on the feedback.
      setFeedback((cur) => {
        if (cur) setPreviousFeedback({ index: e.index - 1, feedback: cur })
        return null
      })
      if (autoSpeak && ttsSupported()) {
        setSpeaking(true)
        // FEEDBACK-LOOP GUARD: while the interviewer voice plays, mute the
        // practice capture so the spoken question is never transcribed into
        // the user's answer buffer.
        const sid = sessionIdRef.current
        if (sid) window.copilot.muteTranscript(sid, true)
        const unmute = (): void => {
          if (sessionIdRef.current) window.copilot.muteTranscript(sessionIdRef.current, false)
        }
        const handle = speak(e.question, {
          lang: settings.responseLanguage,
          rate: 1,
          onEnd: () => {
            unmute()
            setSpeaking(false)
          }
        })
        speakHandleRef.current = {
          cancel: () => {
            handle.cancel()
            unmute()
            setSpeaking(false)
          }
        }
      }
    })
    const offEvaluated = window.copilot.onPracticeEvaluated((e) => {
      if (e.practiceId !== practiceIdRef.current) return
      setFeedback(e.feedback)
      setAwaitingEval(false)
      setEvalStreaming(false)
    })
    const offFinished = window.copilot.onPracticeFinished((e) => {
      if (e.practiceId !== practiceIdRef.current) return
      setScorecard(e.scorecard)
      setPhase('done')
      stopMic()
      // Load the persisted session (turns + info) for the review section.
      void window.copilot.getPractice(e.practiceId).then((d) => {
        if (!d) return
        setSessionInfo(d)
        setTurns(d.turns)
      })
      refreshHistory()
    })
    const offError = window.copilot.onPracticeError((e) => {
      if (e.practiceId !== practiceIdRef.current) return
      setError(e.message)
      setQuestionStreaming(false)
      setAwaitingEval(false)
      setEvalStreaming(false)
      // If the FIRST question never arrived (provider failure/rate limit), the
      // session is unusable — close it and return to setup with the reason.
      if (!question && !feedback && questionStreamingRef.current) {
        void window.copilot.practiceCancel({ practiceId: e.practiceId })
        practiceIdRef.current = null
        setPhase('setup')
        refreshHistory()
      }
    })
    return () => {
      offDelta()
      offQuestion()
      offEvaluated()
      offFinished()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak, settings.responseLanguage, refreshHistory])

  /* ── spoken answers (practice-purpose transcription session) ────────── */
  const startMic = async (): Promise<void> => {
    setMicError(null)
    try {
      if (!sessionIdRef.current) {
        const prepared = await window.copilot.prepareTranscript('mic', 'practice')
        if (!prepared.ok || !prepared.sessionId) {
          setMicError(prepared.message ?? 'Speech input needs a transcription provider (Settings → Listening).')
          return
        }
        sessionIdRef.current = prepared.sessionId
        window.copilot.beginTranscript(prepared.sessionId)
      }
      const sid = sessionIdRef.current
      captureRef.current = await startCapture('mic', undefined, (seq, b64) => {
        if (sid) window.copilot.sendAudioChunk(sid, seq, b64)
      })
      captureRef.current.onEnded(() => setMicOn(false))
      setMicOn(true)
    } catch (err) {
      setMicError(err instanceof CaptureError ? err.message : 'Could not start the microphone.')
      captureRef.current = null
    }
  }

  const stopMic = (): void => {
    captureRef.current?.stop()
    captureRef.current = null
    const sid = sessionIdRef.current
    if (sid) {
      window.copilot.stopTranscript(sid)
      sessionIdRef.current = null
    }
    setMicOn(false)
  }

  useEffect(() => {
    return window.copilot.onTranscriptSegment((e) => {
      if (e.purpose !== 'practice' || e.sessionId !== sessionIdRef.current) return
      setAnswer((prev) => (prev ? prev + ' ' : '') + e.text)
    })
  }, [])

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  const start = async (): Promise<void> => {
    setError(null)
    setTurns([])
    setFeedback(null)
    setScorecard(undefined)
    setQuestion('')
    setAnswer('')
    setIndex(0)
    setDetail(null)
    const res = await window.copilot.practiceStart({
      type,
      difficulty,
      questionCount,
      jobDescription: jd.trim(),
      customFocus: customFocus.trim(),
      role: role.trim(),
      profileId: settings.activeProfileId
    })
    if (res.ok && res.practiceId) {
      practiceIdRef.current = res.practiceId
      setPhase('live')
      questionStreamingRef.current = true
      setQuestionStreaming(true)
    } else {
      setError(res.message ?? 'Could not start the practice interview.')
    }
  }

  const submit = async (): Promise<void> => {
    if (!practiceIdRef.current || !question.trim()) return
    setError(null)
    stopSpeaking()
    setAwaitingEval(true)
    setPreviousFeedback(null)
    const res = await window.copilot.practiceSubmit({
      practiceId: practiceIdRef.current,
      answer: answer.trim(),
      spoken: micOn || answer.trim().length > 0 && spokenThisTurnRef.current
    })
    if (!res.ok) {
      setAwaitingEval(false)
      setError(res.message ?? 'Could not submit the answer.')
    } else {
      spokenThisTurnRef.current = false
      stopMic()
    }
  }
  const spokenThisTurnRef = useRef(false)
  useEffect(() => {
    spokenThisTurnRef.current = micOn
  }, [micOn])

  const endEarly = async (): Promise<void> => {
    if (!practiceIdRef.current) return
    stopSpeaking()
    stopMic()
    const res = await window.copilot.practiceEnd({ practiceId: practiceIdRef.current })
    if (!res.ok) setError(res.message ?? 'Could not finish the practice session.')
  }

  const cancelPractice = async (): Promise<void> => {
    if (!practiceIdRef.current) return
    stopSpeaking()
    stopMic()
    await window.copilot.practiceCancel({ practiceId: practiceIdRef.current })
    setPhase('setup')
    refreshHistory()
  }

  const newPractice = (): void => {
    stopSpeaking()
    setSessionInfo(null)
    setDetail(null)
    setScorecard(undefined)
    setTurns([])
    setQuestion('')
    setAnswer('')
    setFeedback(null)
    setPreviousFeedback(null)
    setAwaitingEval(false)
    setPhase('setup')
    refreshHistory()
  }

  const openSaved = async (s: PracticeSessionInfo): Promise<void> => {
    const d = await window.copilot.getPractice(s.practiceId)
    if (!d) return
    setDetail(d)
    setSessionInfo(d)
    setScorecard(d.scorecard)
    practiceIdRef.current = d.practiceId
    setPhase(d.status === 'completed' ? 'done' : 'review')
  }

  const deleteSaved = async (s: PracticeSessionInfo): Promise<void> => {
    await window.copilot.deletePractice(s.practiceId)
    if (detail?.practiceId === s.practiceId) newPractice()
    refreshHistory()
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  if (phase === 'setup') {
    return (
      <>
        <div className="card">
          <div className="section-title">Choose an interview type</div>
          <div className="practice-type-grid">
            {TYPES.map((t) => (
              <button key={t.id} className={`type-card ${type === t.id ? 'active' : ''}`} onClick={() => setType(t.id)}>
                <span className="t-name">{t.name}</span>
                <span className="t-desc">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="section-title">Configure</div>
          <div className="row">
            <label>Difficulty</label>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as PracticeDifficulty)}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <label>Questions</label>
            <select value={String(questionCount)} onChange={(e) => setQuestionCount(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 7, 8, 10].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="row">
            <input className="grow" type="text" placeholder="Role (optional — e.g. Senior frontend engineer)" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
          {type === 'custom' && (
            <div className="row">
              <input className="grow" type="text" placeholder="What should this interview focus on?" value={customFocus} onChange={(e) => setCustomFocus(e.target.value)} />
            </div>
          )}
          <textarea
            className="practice-answer"
            style={{ minHeight: 64 }}
            placeholder="Paste a job description (optional — aligns the questions)"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
          />
          <div className="row">
            <span className="badge accent">Profile: {settings.activeProfileId === 'default' ? 'Default' : settings.activeProfileId}</span>
            <span className="hint">Your profile facts ground the questions — they never fabricate experience.</span>
          </div>
          <div className="row">
            <label>
              <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} /> Read questions aloud
            </label>
            {!ttsSupported() && <span className="badge warn">speech not available</span>}
          </div>
          <div className="row">
            <button className="primary" onClick={() => void start()}>
              ▶ Start practice interview
            </button>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>

        <div className="card">
          <div className="section-title">Past practice sessions</div>
          {history === null ? (
            <LoadingRow label="Loading…" />
          ) : history.length === 0 ? (
            <div className="hint">No practice sessions yet.</div>
          ) : (
            <div className="mt-list">
              {history.map((s) => (
                <div key={s.practiceId} className="row" style={{ gap: 6 }}>
                  <button className="mt-item grow" onClick={() => void openSaved(s)}>
                    <span className="mt-title grow">{TYPE_LABEL[s.type] ?? s.type} · {s.difficulty}</span>
                    <span className="mt-meta">
                      {s.scorecard ? `${s.scorecard.overall}/5 · ` : ''}
                      {s.status} · {shortTime(s.updatedAt)}
                    </span>
                  </button>
                  <button className="meta-btn" title="Delete" onClick={() => void deleteSaved(s)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    )
  }

  if (phase === 'live') {
    const progress = Math.min(100, Math.round(((feedback ? index : Math.max(0, index - 1)) / questionCount) * 100))
    return (
      <>
        <div className="iv-session">
          <span className={`dot ${micOn ? 'rec' : 'live'}`} />
          <span className="iv-status">Practice · {TYPE_LABEL[type] ?? type} · {difficulty}</span>
          <span className="grow" />
          <span className="badge">Question {Math.max(1, index)} / {questionCount}</span>
          <button className="chip" onClick={() => void endEarly()} title="Finish now and get a scorecard">
            End &amp; score
          </button>
          <button className="meta-btn" onClick={() => void cancelPractice()} title="Discard this session">
            discard
          </button>
        </div>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>

        <div className="card">
          <div className="row">
            <div className="section-title">Interviewer</div>
            <span className="grow" />
            {ttsSupported() && question && (
              <button
                className="chip"
                onClick={() => {
                  if (speaking) {
                    stopSpeaking()
                    if (sessionIdRef.current) window.copilot.muteTranscript(sessionIdRef.current, false)
                    setSpeaking(false)
                  } else {
                    setSpeaking(true)
                    const sid = sessionIdRef.current
                    if (sid) window.copilot.muteTranscript(sid, true)
                    speak(question, {
                      lang: settings.responseLanguage,
                      rate: 1,
                      onEnd: () => {
                        if (sessionIdRef.current) window.copilot.muteTranscript(sessionIdRef.current, false)
                        setSpeaking(false)
                      }
                    })
                  }
                }}
              >
                {speaking ? '◼ Stop reading' : '🔊 Read aloud'}
              </button>
            )}
          </div>
          {question ? (
            <div className="practice-question">{question}{questionStreaming && <span className="stream-cursor" />}</div>
          ) : (
            <LoadingRow label="Preparing your first question…" />
          )}
        </div>

        {previousFeedback && (
          <div className="card" style={{ opacity: 0.85 }}>
            <div className="row">
              <div className="section-title">Feedback on answer {previousFeedback.index}</div>
              <span className="grow" />
              <span className="badge accent">{previousFeedback.feedback.overall}/5 overall</span>
            </div>
            <div className="score-grid">
              {previousFeedback.feedback.dimensions.map((d) => (
                <ScoreRow key={d.dimension} name={d.dimension} score={d.score} />
              ))}
            </div>
            {previousFeedback.feedback.improvements.length > 0 && (
              <div className="hint">Improve: {previousFeedback.feedback.improvements.join(' · ')}</div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="iv-label">Your answer — typed or spoken</div>
          <textarea
            className="practice-answer"
            value={answer}
            placeholder="Write your answer here, or turn on the microphone and speak. Submit when done."
            onChange={(e) => setAnswer(e.target.value)}
            disabled={evalStreaming || feedback !== null}
          />
          <div className="row wrap">
            {micOn ? (
              <button className="secondary" onClick={stopMic}>■ Stop microphone</button>
            ) : (
              <button className="chip" onClick={() => void startMic()} disabled={evalStreaming || feedback !== null}>
                🎤 Speak answer
              </button>
            )}
            {micOn && <span className="badge err">listening — your speech is transcribed into the box</span>}
            <span className="grow" />
            {feedback === null && !awaitingEval && !evalStreaming && (
              <button className="primary" disabled={!answer.trim() || questionStreaming} onClick={() => void submit()}>
                Submit answer
              </button>
            )}
            {awaitingEval && !evalStreaming && <span className="badge accent">waiting for the evaluation…</span>}
          </div>
          {micError && <ErrorBox>{micError}</ErrorBox>}
          {error && <ErrorBox>{error}</ErrorBox>}
          {evalStreaming && <LoadingRow label="Evaluating your answer…" />}
        </div>

        {feedback && (
          <div className="card">
            <div className="row">
              <div className="section-title">Feedback</div>
              <span className="grow" />
              <span className="badge accent">{feedback.overall}/5 overall</span>
            </div>
            <div className="score-grid">
              {feedback.dimensions.map((d) => (
                <ScoreRow key={d.dimension} name={d.dimension} score={d.score} />
              ))}
            </div>
            {feedback.strengths.length > 0 && (
              <div>
                <div className="iv-label">Strengths</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  {feedback.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {feedback.improvements.length > 0 && (
              <div>
                <div className="iv-label">Improve</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  {feedback.improvements.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {feedback.improvedAnswer && (
              <details>
                <summary className="meta-btn" style={{ cursor: 'pointer' }}>Suggested improved answer (uses only what you said)</summary>
                <div className="iv-answer" style={{ marginTop: 6 }}>{feedback.improvedAnswer}</div>
              </details>
            )}
            <div className="hint">
              {index >= questionCount ? 'That was the last question — the scorecard is being prepared…' : 'The next question is being prepared…'}
            </div>
          </div>
        )}
      </>
    )
  }

  if (phase === 'review' && detail) {
    return (
      <>
        <div className="iv-session">
          <span className="dot" />
          <span className="iv-status">{TYPE_LABEL[detail.type] ?? detail.type} · {detail.difficulty}</span>
          <span className="badge">{detail.status}</span>
          <span className="grow" />
          <button className="chip" onClick={newPractice}>+ New practice</button>
        </div>
        {detail.turns.map((t) => (
          <div key={t.index} className="turn-card">
            <div className="turn-q">Q{t.index}. {t.question}</div>
            <div className="turn-a">{t.answer || '(no answer)'}</div>
            {t.feedback && <div className="badge accent">overall {t.feedback.overall}/5</div>}
          </div>
        ))}
      </>
    )
  }

  // phase === 'done'
  return (
    <>
      <div className="card">
        <div className="row">
          <div className="section-title">Scorecard</div>
          <span className="grow" />
          {sessionInfo && <span className="badge">{TYPE_LABEL[sessionInfo.type] ?? sessionInfo.type} · {sessionInfo.difficulty}</span>}
        </div>
        {scorecard ? (
          <>
            <div className="overall-score">
              <span className="big">{scorecard.overall}</span>
              <span className="of">/ 5 overall</span>
            </div>
            <div className="score-grid">
              <ScoreRow name="Communication" score={scorecard.communication} />
              <ScoreRow name="Technical accuracy" score={scorecard.technicalAccuracy} />
              <ScoreRow name="Relevance" score={scorecard.relevance} />
              <ScoreRow name="Completeness" score={scorecard.completeness} />
              <ScoreRow name="Problem solving" score={scorecard.problemSolving} />
            </div>
            <div className="hint" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>{scorecard.summary}</div>
            {scorecard.areasForImprovement.length > 0 && (
              <div>
                <div className="iv-label">Areas for improvement</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  {scorecard.areasForImprovement.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
          </>
        ) : (
          <LoadingRow label="Preparing the scorecard…" />
        )}
        <div className="row">
          <button className="primary" onClick={newPractice}>New practice session</button>
        </div>
      </div>

      {turns.length > 0 && (
        <div className="card">
          <div className="section-title">Question-by-question review</div>
          {turns.map((t) => (
            <div key={t.index} className="turn-card">
              <div className="turn-q">Q{t.index}. {t.question}</div>
              <div className="turn-a">{t.answer || '(no answer)'}{t.spoken ? ' · 🎤 spoken' : ''}</div>
              {t.feedback && (
                <>
                  <div className="score-grid">
                    {t.feedback.dimensions.map((d) => (
                      <ScoreRow key={d.dimension} name={d.dimension} score={d.score} />
                    ))}
                  </div>
                  {t.feedback.improvements.length > 0 && (
                    <div className="hint">Improve: {t.feedback.improvements.join(' · ')}</div>
                  )}
                  {t.feedback.improvedAnswer && (
                    <details>
                      <summary className="meta-btn" style={{ cursor: 'pointer' }}>Suggested improved answer</summary>
                      <div className="iv-answer" style={{ marginTop: 6 }}>{t.feedback.improvedAnswer}</div>
                    </details>
                  )}
                </>
              )}
              {!t.feedback && <span className="badge warn">not evaluated</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
