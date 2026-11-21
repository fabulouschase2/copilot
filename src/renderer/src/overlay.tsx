/**
 * Private overlay renderer (Phase 6).
 *
 * Displays live interviewer captions and the latest answer in a frameless
 * window. The main process owns capture exclusion; this view only reflects
 * the OS-confirmed state it is given — it never claims privacy on its own.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OverlayContent, OverlayStateInfo } from '../../shared/protocol'
import './theme.css'
import './overlay.css'

const MAX_CAPTIONS = 3

function OverlayView(): React.JSX.Element {
  const [state, setState] = useState<OverlayStateInfo | null>(null)
  const [captions, setCaptions] = useState<Array<{ text: string; source?: 'mic' | 'system' }>>([])
  const [answer, setAnswer] = useState<{ text: string; question?: string } | null>(null)
  const [empty, setEmpty] = useState(true)
  const answerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const load = (attempt = 0): void => {
      window.copilot
        .getOverlayState()
        .then((s) => {
          if (!cancelled) setState((cur) => cur ?? s)
        })
        .catch(() => {
          // The handler may not be registered yet during early startup.
          if (!cancelled && attempt < 5) retry = setTimeout(() => load(attempt + 1), 300)
        })
    }
    load()
    const offState = window.copilot.onOverlayState((e) => setState(e))
    const offContent = window.copilot.onOverlayContent((e: OverlayContent) => {
      setEmpty(false)
      if (e.kind === 'caption') {
        setCaptions((cur) => [...cur, { text: e.text, source: e.source }].slice(-MAX_CAPTIONS))
        return
      }
      if (e.kind === 'answer') {
        setAnswer({ text: e.text, question: e.question })
        setCaptions([])
      }
    })
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      offState()
      offContent()
    }
  }, [])

  useEffect(() => {
    const el = answerRef.current
    if (el) el.scrollTop = 0
  }, [answer])

  const fontSize = state?.fontSize ?? 15
  const exclusionLabel =
    state === null
      ? 'checking…'
      : state.support !== 'supported'
        ? 'capture exclusion unavailable'
        : state.exclusionActive
          ? 'excluded from capture'
          : state.exclusionUnverified
            ? 'exclusion NOT applied'
            : 'capturable'

  const exclusionClass =
    state?.exclusionActive === true
      ? 'ok'
      : state !== null && state.support !== 'supported'
        ? 'warn'
        : state?.exclusionUnverified
          ? 'err'
          : 'dim'

  return (
    <div className="overlay" data-theme="dark">
      <div className="ov-bar">
        <span className="ov-brand">
          <span className="ov-logo" />
          Copilot
        </span>
        <span className={`ov-state ${exclusionClass}`} title={state?.supportMessage ?? ''}>
          ● {exclusionLabel}
        </span>
        <span className="ov-grow" />
        <button className="ov-btn" title="Hide overlay (Ctrl+Alt+O)" onClick={() => window.copilot.hideOverlay()}>
          ✕
        </button>
      </div>

      <div className="ov-body" style={{ fontSize }}>
        {state?.showCaptions !== false && captions.length > 0 && (
          <div className="ov-captions">
            {captions.map((c, i) => (
              <div key={i} className={`ov-caption ${c.source === 'mic' ? 'mic' : ''}`}>
                <span className="ov-src">{c.source === 'mic' ? 'You' : 'Them'}</span>
                {c.text}
              </div>
            ))}
          </div>
        )}
        {answer ? (
          <div className="ov-answer" ref={answerRef}>
            {answer.question && <div className="ov-question">{answer.question}</div>}
            <div className="ov-text">{answer.text}</div>
          </div>
        ) : (
          !empty && <div className="ov-placeholder">Listening…</div>
        )}
        {empty && (
          <div className="ov-placeholder">
            Private overlay ready. Start an interview session — captions and answers appear here.
          </div>
        )}
      </div>

      <div className="ov-foot">
        <span className="ov-hint">
          {state?.support === 'supported'
            ? 'Windows capture exclusion · visible only on this display'
            : (state?.supportMessage ?? 'Checking capture exclusion support…')}
        </span>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (container) createRoot(container).render(<OverlayView />)
