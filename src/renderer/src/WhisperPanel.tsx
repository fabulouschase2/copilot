/**
 * Local Whisper settings (Phase 1).
 *
 * Configures the managed whisper.cpp server, reports its real process state,
 * and creates the STT provider row that routes transcription through it.
 * Nothing here pretends the server is running before it answers on its port.
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  WhisperCandidate,
  WhisperStatusInfo
} from '../../shared/protocol'

interface Props {
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' }
]

function phaseTone(p: WhisperStatusInfo['phase']): string {
  switch (p) {
    case 'running':
      return 'ok'
    case 'starting':
      return 'warn'
    case 'failed':
      return 'err'
    default:
      return ''
  }
}

export function WhisperPanel({ settings, onChange }: Props): React.JSX.Element {
  const [status, setStatus] = useState<WhisperStatusInfo | null>(null)
  const [candidates, setCandidates] = useState<WhisperCandidate[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const local = settings.localWhisper
  const activeRow = settings.stt.providers.find((p) => p.id === 'local-whisper')
  const usingForTranscription = activeRow !== undefined && settings.stt.activeSttProviderId === 'local-whisper'

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.copilot.whisperStatus())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const configure = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      setBusy(true)
      setMessage(null)
      try {
        const result = await window.copilot.configureWhisper(patch)
        setStatus(result.status)
        onChange(result.settings)
      } finally {
        setBusy(false)
      }
    },
    [onChange]
  )

  const detect = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.copilot.detectWhisper()
      setCandidates(res.candidates)
      setMessage(
        res.candidates.length === 0
          ? 'No whisper.cpp install found. Set the executable and model paths manually.'
          : `${res.candidates.length} install(s) found.`
      )
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.copilot.startWhisper()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.copilot.stopWhisper()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="whisper-panel">
      <div className="section-title">Local speech recognition (whisper.cpp)</div>
      <p className="hint">
        Runs entirely on this machine: no audio leaves the device and no API key is needed. The
        server is managed by Copilot — you do not have to start it yourself. Captions are
        final-only (one transcript per spoken utterance), the same as any batch STT provider.
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Server</div>
            <div className="hint">
              {status ? status.message : 'Checking…'}
              {status?.pid ? ` · pid ${status.pid}` : ''}
            </div>
          </div>
          <span className={`badge ${phaseTone(status?.phase ?? 'stopped')}`}>
            {status?.phase ?? 'stopped'}
          </span>
        </div>

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button className="primary" disabled={busy || status?.phase === 'running'} onClick={() => void start()}>
            Start
          </button>
          <button className="secondary" disabled={busy || status?.phase !== 'running'} onClick={() => void stop()}>
            Stop
          </button>
          <button className="secondary" disabled={busy} onClick={() => void detect()}>
            Detect install
          </button>
        </div>

        {status && !status.serverExePresent && (
          <div className="hint" style={{ marginTop: 6 }}>
            Executable missing: {status.serverExe || '(not set)'}
          </div>
        )}
        {status && !status.modelPresent && (
          <div className="hint" style={{ marginTop: 2 }}>
            Model missing: {status.modelPath || '(not set)'}
          </div>
        )}
        {status?.lastError && <div className="error-text" style={{ marginTop: 6 }}>{status.lastError}</div>}
        {message && <div className="hint" style={{ marginTop: 6 }}>{message}</div>}

        {candidates.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {candidates.map((c) => (
              <div key={c.modelPath} className="row compact">
                <span className="badge">{c.modelSize}</span>
                <span className="grow" title={c.modelPath}>
                  {c.modelPath}
                </span>
                <button
                  className="chip"
                  onClick={() =>
                    void configure({
                      serverExe: c.serverExe,
                      modelPath: c.modelPath,
                      useForTranscription: true
                    })
                  }
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        )}

        {status && status.logTail.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary className="hint">Server output ({status.logTail.length} lines)</summary>
            <pre className="hint" style={{ maxHeight: 140, overflow: 'auto', margin: '6px 0 0' }}>
              {status.logTail.slice(-12).join('\n')}
            </pre>
          </details>
        )}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>Paths and model</div>
        <div className="row">
          <input
            className="grow"
            type="text"
            placeholder="C:\path\to\whisper-server.exe"
            value={local.serverExe}
            onChange={(e) => onChange({ ...settings, localWhisper: { ...local, serverExe: e.target.value } })}
          />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <input
            className="grow"
            type="text"
            placeholder="C:\path\to\ggml-tiny.bin"
            value={local.modelPath}
            onChange={(e) => onChange({ ...settings, localWhisper: { ...local, modelPath: e.target.value } })}
          />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <label className="hint" style={{ width: 44 }}>Port</label>
          <input
            type="number"
            min={1024}
            max={65535}
            style={{ width: 90 }}
            value={local.port}
            onChange={(e) => onChange({ ...settings, localWhisper: { ...local, port: Number(e.target.value) } })}
          />
          <label className="hint" style={{ width: 56 }}>Threads</label>
          <input
            type="number"
            min={1}
            max={16}
            style={{ width: 70 }}
            value={local.threads}
            onChange={(e) => onChange({ ...settings, localWhisper: { ...local, threads: Number(e.target.value) } })}
          />
          <select
            value={local.language}
            onChange={(e) => onChange({ ...settings, localWhisper: { ...local, language: e.target.value } })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" disabled={busy} onClick={() => void configure({})}>
            Save paths
          </button>
          <button
            className={usingForTranscription ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => void configure({ useForTranscription: !usingForTranscription })}
          >
            {usingForTranscription ? 'Used for transcription' : 'Use for transcription'}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Keep the model small on 8 GB machines: `tiny` transcribes quickly on CPU, `base` is more
          accurate and still CPU-friendly. Larger models work but compete for memory with the app.
        </div>
      </div>
    </div>
  )
}
