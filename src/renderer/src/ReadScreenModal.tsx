import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  ScreenAnalysisResult,
  ScreenKind,
  ScreenSourceInfo
} from '../../shared/protocol'
import { renderAnswer } from './answerRender'
import { ErrorBox, NoticeBox, Spinner } from './ui'

/**
 * Read screen — the consent-gated screen-understanding flow (transformation
 * rebuild). Explicit arm → source picker (screens/windows) → optional drag
 * region on the preview → structured analysis with retry. One capture per
 * click, nothing in the background, provider errors surface verbatim.
 */

type Preset = 'explain' | 'answer' | 'code' | 'custom'

const PRESETS: Array<{ id: Preset; label: string; question: string }> = [
  { id: 'explain', label: 'Explain screen', question: 'Explain what is visible on this screen in a clear, structured way. Note anything important that is hard to notice.' },
  { id: 'answer', label: 'Answer visible question', question: 'If an interview or quiz question is visible, state it verbatim, then answer it concisely and correctly.' },
  { id: 'code', label: 'Solve coding problem', question: 'If a coding problem is visible, state it briefly, then solve it: working code first, then complexity and edge cases.' }
]

export function ReadScreenModal(props: { settings: AppSettings; onClose: () => void }): React.JSX.Element {
  const { onClose } = props
  const [kind, setKind] = useState<ScreenKind>('screen')
  const [sources, setSources] = useState<ScreenSourceInfo[] | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('explain')
  const [customQuestion, setCustomQuestion] = useState('')
  const [preview, setPreview] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [region, setRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ScreenAnalysisResult | null>(null)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  /* arm consent + load sources on open */
  useEffect(() => {
    void window.copilot.armScreen(true).then((r) => {
      if (!r.ok) setError(r.message ?? 'Screen analysis could not be enabled.')
    })
  }, [])

  const loadSources = useCallback(async (k: ScreenKind): Promise<void> => {
    setSources(null)
    setSourceId(null)
    const res = await window.copilot.listScreenSources(k)
    if (!res.ok) {
      setError(res.message ?? 'Could not list capture sources.')
      setSources([])
      return
    }
    setSources(res.sources ?? [])
    if (res.sources && res.sources.length > 0) setSourceId(res.sources[0].id)
  }, [])

  useEffect(() => {
    void loadSources(kind)
  }, [kind, loadSources])

  /* streaming results */
  useEffect(() => {
    const offPreview = window.copilot.onScreenPreview((e) => {
      if (e.requestId !== requestIdRef.current) return
      setPreview({ dataUrl: e.dataUrl, width: e.width, height: e.height })
      if (!e.duplicate) setRegion(null) // fresh capture invalidates an old selection
    })
    const offDelta = window.copilot.onScreenDelta((e) => {
      if (e.requestId !== requestIdRef.current) return
      setStreamText((p) => p + e.delta)
    })
    const offResult = window.copilot.onScreenResult((e) => {
      if (e.requestId !== requestIdRef.current) return
      setRunning(false)
      setResult(e)
      if (e.status === 'duplicate') setNotice('Same capture as before — skipped the provider call. Change something on screen or press Analyze again with a selection.')
    })
    const offError = window.copilot.onScreenError((e) => {
      if (e.requestId !== requestIdRef.current) return
      setRunning(false)
      setError(e.message)
    })
    return () => {
      offPreview()
      offDelta()
      offResult()
      offError()
    }
  }, [])

  const questionText = (): string => {
    if (preset === 'custom') return customQuestion.trim() || PRESETS[0].question
    return PRESETS.find((p) => p.id === preset)?.question ?? PRESETS[0].question
  }

  const analyze = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    setResult(null)
    setStreamText('')
    setRunning(true)
    window.copilot.clearScreen()
    const res = await window.copilot.analyzeScreen({
      kind,
      sourceId: sourceId ?? undefined,
      region: region ?? undefined,
      question: questionText(),
      includeTranscript: false,
      includeContext: true
    })
    if (res.ok && res.requestId) {
      requestIdRef.current = res.requestId
    } else {
      setRunning(false)
      setError(res.message ?? 'Could not start screen analysis.')
    }
  }

  const retry = async (): Promise<void> => {
    if (region) {
      await analyze()
      return
    }
    setNotice(null)
    setError(null)
    setRunning(true)
    setResult(null)
    setStreamText('')
    const res = await window.copilot.analyzeScreen({
      kind,
      sourceId: sourceId ?? undefined,
      question: questionText(),
      includeTranscript: false,
      includeContext: true
    })
    if (res.ok && res.requestId) requestIdRef.current = res.requestId
    else {
      setRunning(false)
      setError(res.message ?? 'Could not restart analysis.')
    }
  }

  /* drag-to-select a normalized region on the preview */
  const onImgPointerDown = (e: React.PointerEvent<HTMLImageElement>): void => {
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    dragStartRef.current = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
    setRegion(null)
  }
  const onImgPointerMove = (e: React.PointerEvent<HTMLImageElement>): void => {
    const start = dragStartRef.current
    const img = imgRef.current
    if (!start || !img) return
    const rect = img.getBoundingClientRect()
    const cx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const cy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    setRegion({
      x: Math.min(start.x, cx),
      y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x),
      h: Math.abs(cy - start.y)
    })
  }
  const onImgPointerUp = (): void => {
    dragStartRef.current = null
    setRegion((r) => (r && (r.w < 0.03 || r.h < 0.03) ? null : r))
  }

  const answerText = streamText || (result && result.observations) || ''
  const analysisDone = result !== null && (result.status === 'completed' || result.status === 'duplicate')

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Read screen">
        <div className="row">
          <div className="section-title">Read screen</div>
          <span className="grow" />
          <button className="icon" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="row">
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as ScreenKind
              setKind(next)
              void loadSources(next)
            }}
            disabled={running}
          >
            <option value="screen">Entire screen</option>
            <option value="window">A window</option>
          </select>
          {sources === null ? (
            <span className="hint">loading…</span>
          ) : sources.length === 0 ? (
            <span className="badge warn">no sources</span>
          ) : null}
        </div>

        {sources !== null && sources.length > 0 && (
          <div className="source-grid">
            {sources.map((s) => (
              <button
                key={s.id}
                className={`source-thumb ${sourceId === s.id ? 'active' : ''}`}
                onClick={() => setSourceId(s.id)}
                disabled={running}
              >
                <img src={s.thumbnailDataUrl} alt={s.name} />
                <span className="s-name">{s.name}</span>
              </button>
            ))}
          </div>
        )}

        <div className="row wrap">
          {PRESETS.map((p) => (
            <button key={p.id} className={`pill ${preset === p.id ? 'pill-active' : ''}`} onClick={() => setPreset(p.id)} disabled={running}>
              {p.label}
            </button>
          ))}
          <button className={`pill ${preset === 'custom' ? 'pill-active' : ''}`} onClick={() => setPreset('custom')} disabled={running}>
            Ask…
          </button>
        </div>
        {preset === 'custom' && (
          <input
            type="text"
            placeholder="What should the analysis answer about the screen?"
            value={customQuestion}
            onChange={(e) => setCustomQuestion(e.target.value)}
            disabled={running}
          />
        )}

        <div className="row">
          <button className="primary" onClick={() => void analyze()} disabled={running || !sourceId}>
            {running ? 'Analyzing…' : analysisDone ? 'Capture again' : 'Analyze screen'}
          </button>
          {analysisDone && (
            <button className="secondary" onClick={() => void retry()} disabled={running} title="Retry the analysis">
              Retry
            </button>
          )}
          {region && (
            <button className="ghost" onClick={() => setRegion(null)} disabled={running}>
              clear selection
            </button>
          )}
          <span className="grow" />
          {running && <Spinner />}
        </div>

        {preview && (
          <div>
            <div className="iv-label" style={{ marginBottom: 4 }}>
              Capture preview {region ? '· selection active' : '· drag to select a region'}
            </div>
            <img
              ref={imgRef}
              src={preview.dataUrl}
              alt="Captured screen"
              style={{ width: '100%', borderRadius: 7, border: '1px solid var(--border)', display: 'block', touchAction: 'none' }}
              onPointerDown={onImgPointerDown}
              onPointerMove={onImgPointerMove}
              onPointerUp={onImgPointerUp}
              draggable={false}
            />
          </div>
        )}

        {notice && <NoticeBox>{notice}</NoticeBox>}
        {error && <ErrorBox>{error}</ErrorBox>}

        {(running || answerText) && (
          <div>
            <div className="iv-label" style={{ marginBottom: 4 }}>Analysis</div>
            <div className="iv-answer" style={{ minHeight: 60 }} aria-live="polite">
              {answerText ? renderAnswer(answerText) : <span className="hint">Waiting for the provider…</span>}
            </div>
            {analysisDone && result?.provider && (
              <div className="answer-meta" style={{ marginTop: 6 }}>
                <span className="badge">{result.provider.label} · {result.provider.model}</span>
                {result.processing.totalMs > 0 && <span>{(result.processing.totalMs / 1000).toFixed(1)}s</span>}
                {result.processing.sentWidth !== null && result.processing.sentHeight !== null && (
                  <span>{result.processing.sentWidth}×{result.processing.sentHeight}px</span>
                )}
                <button className="meta-btn" onClick={() => void navigator.clipboard.writeText(answerText)}>copy</button>
              </div>
            )}
          </div>
        )}

        <div className="hint">
          One capture per click — nothing runs in the background. The capture window is visible while analysis runs.
        </div>
      </div>
    </div>
  )
}
