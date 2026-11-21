/**
 * Live translation (Phase 4).
 *
 * Captures mic or system audio, transcribes it through the configured STT
 * provider, and translates each finalized line into the target language.
 * Every translated line names the provider that produced it; failed lines are
 * shown as failures rather than silently dropped.
 *
 * History is session-scoped and memory-only, consistent with the app's
 * transcript policy (nothing is written to disk).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  TranslationResultEvent,
  TranscriptSource,
  TranscriptStatusEvent
} from '../../shared/protocol'
import { TRANSLATION_LANGUAGES } from '../../shared/languages'
import { startCapture, CaptureSession } from './audio/capture'

const MAX_ROWS = 200

interface Row {
  segmentId: string
  original: string
  translated?: string
  provider?: string
  error?: string
  pending: boolean
  at: string
}

interface Props {
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

export function TranslationPanel({ settings, onChange }: Props): React.JSX.Element {
  const [session, setSession] = useState<TranscriptStatusEvent | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<TranscriptSource>('system')
  const [busy, setBusy] = useState(false)
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; providerLabel: string; message?: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  const captureRef = useRef<CaptureSession | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const translation = settings.translation
  const activeProvider =
    settings.providers.find((p) => p.id === settings.activeProviderId && p.enabled)?.label ??
    settings.providers.find((p) => p.enabled)?.label ??
    null

  useEffect(() => {
    const offStatus = window.copilot.onTranscriptStatus((e) => {
      if (sessionIdRef.current && e.sessionId !== sessionIdRef.current && e.state !== 'stopped') return
      setSession(e)
    })
    const offSegment = window.copilot.onTranscriptSegment((e) => {
      if (e.purpose !== 'translation') return
      setRows((cur) => {
        if (cur.some((r) => r.segmentId === e.segmentId)) return cur
        const next: Row[] = [
          ...cur,
          { segmentId: e.segmentId, original: e.text, pending: true, at: e.wallTime }
        ]
        return next.slice(-MAX_ROWS)
      })
    })
    const offResult = window.copilot.onTranslationResult((e: TranslationResultEvent) => {
      setRows((cur) => {
        const existing = cur.find((r) => r.segmentId === e.segmentId)
        if (existing) {
          return cur.map((r) =>
            r.segmentId === e.segmentId
              ? { ...r, translated: e.translated, provider: e.providerLabel, pending: false }
              : r
          )
        }
        return [
          ...cur,
          {
            segmentId: e.segmentId,
            original: e.original,
            translated: e.translated,
            provider: e.providerLabel,
            pending: false,
            at: e.at
          }
        ].slice(-MAX_ROWS)
      })
    })
    const offError = window.copilot.onTranslationError((e) => {
      setRows((cur) =>
        cur.map((r) =>
          r.segmentId === e.segmentId ? { ...r, pending: false, error: e.message } : r
        )
      )
    })
    return () => {
      offStatus()
      offSegment()
      offResult()
      offError()
    }
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows])

  const stop = useCallback(async (): Promise<void> => {
    captureRef.current?.stop()
    captureRef.current = null
    const id = sessionIdRef.current
    sessionIdRef.current = null
    if (id) window.copilot.stopTranscript(id)
    setBusy(false)
  }, [])

  const start = async (): Promise<void> => {
    if (!translation.enabled) onChange({ ...settings, translation: { ...translation, enabled: true } })
    setBusy(true)
    setError(null)
    setRows([])
    const prepared = await window.copilot.prepareTranscript(source, 'translation')
    if (!prepared.ok || !prepared.sessionId) {
      setError(prepared.message ?? 'Could not start the translation session.')
      setBusy(false)
      return
    }
    sessionIdRef.current = prepared.sessionId
    window.copilot.beginTranscript(prepared.sessionId)
    try {
      captureRef.current = await startCapture(source, undefined, (seq, b64) => {
        if (sessionIdRef.current) window.copilot.sendAudioChunk(sessionIdRef.current, seq, b64)
      })
      captureRef.current.onEnded(() => {
        setError('The audio device disconnected. The session was stopped.')
        void stop()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the audio source.')
      window.copilot.stopTranscript(prepared.sessionId)
      sessionIdRef.current = null
      setBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    if (!testText.trim()) return
    setTesting(true)
    try {
      setTestResult(await window.copilot.testTranslation(testText.trim()))
    } finally {
      setTesting(false)
    }
  }

  const listening = session?.state === 'listening' || session?.state === 'paused'

  return (
    <div className="translate-panel">
      <div className="card">
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Live translation</div>
            <div className="hint">
              {activeProvider ? `Translated by ${activeProvider}` : 'No chat provider configured'}
            </div>
          </div>
          <span className={`badge ${listening ? 'ok' : ''}`}>{listening ? 'live' : 'idle'}</span>
        </div>

        <div className="row wrap" style={{ marginTop: 10 }}>
          <select
            value={source}
            disabled={listening}
            onChange={(e) => setSource(e.target.value as TranscriptSource)}
          >
            <option value="system">System audio (them)</option>
            <option value="mic">Microphone (you)</option>
          </select>
          <select
            value={translation.targetLanguage}
            onChange={(e) =>
              onChange({ ...settings, translation: { ...translation, targetLanguage: e.target.value } })
            }
          >
            {TRANSLATION_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          {listening ? (
            <button className="danger" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={busy} onClick={() => void start()}>
              Start listening
            </button>
          )}
        </div>

        <div className="row wrap" style={{ marginTop: 8 }}>
          <label className="hint">
            <input
              type="checkbox"
              checked={translation.showOriginal}
              onChange={(e) =>
                onChange({ ...settings, translation: { ...translation, showOriginal: e.target.checked } })
              }
            />{' '}
            Show original
          </label>
          <label className="hint">
            Caption size
            <input
              type="range"
              min={11}
              max={24}
              value={translation.fontSize}
              onChange={(e) =>
                onChange({ ...settings, translation: { ...translation, fontSize: Number(e.target.value) } })
              }
            />
          </label>
        </div>

        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
        {!translation.enabled && (
          <div className="hint" style={{ marginTop: 6 }}>
            Translation turns on automatically when you start listening.
          </div>
        )}
      </div>

      <div className="card translate-captions" ref={listRef}>
        {rows.length === 0 && (
          <div className="hint">
            Captions appear here. Start listening to translate speech into{' '}
            {TRANSLATION_LANGUAGES.find((l) => l.code === translation.targetLanguage)?.label ?? translation.targetLanguage}.
          </div>
        )}
        {rows.map((r) => (
          <div key={r.segmentId} className="translate-row" style={{ fontSize: translation.fontSize }}>
            {translation.showOriginal && <div className="translate-original">{r.original}</div>}
            <div className="translate-translated">
              {r.error ? (
                <span className="error-text">Translation failed: {r.error}</span>
              ) : r.pending ? (
                <span className="hint">translating…</span>
              ) : (
                r.translated
              )}
            </div>
            {r.provider && <div className="translate-meta">{r.provider}</div>}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>Test the engine</div>
        <div className="row">
          <input
            className="grow"
            type="text"
            placeholder="Type a sentence to translate with the active provider"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runTest()}
          />
          <button className="secondary" disabled={testing || !testText.trim()} onClick={() => void runTest()}>
            {testing ? 'Translating…' : 'Translate'}
          </button>
        </div>
        {testResult && (
          <div className="hint" style={{ marginTop: 8 }}>
            {testResult.ok ? (
              <>
                <div style={{ color: 'var(--text)' }}>{testResult.text}</div>
                <div>via {testResult.providerLabel}</div>
              </>
            ) : (
              <span className="error-text">{testResult.message ?? 'Translation failed.'}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
