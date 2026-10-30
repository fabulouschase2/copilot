import { useEffect, useState } from 'react'
import { AudioDiagnosticsInfo } from '../../shared/protocol'
import { captureDiagnostics, subscribeCaptureDiagnostics } from './audio/capture-state'
import { fmtStamp } from './ui'

/**
 * Audio diagnostics (transformation §6). Shows the full pipeline state from
 * the Start click to the transcript, with NO audio content and NO secrets:
 * states, counters, sample rates, and timestamps only.
 *
 * Distinctions required by the audit brief: Not started / Waiting for
 * permission / Capturing / Receiving audio / Transcribing / Listening but
 * silent / Provider disconnected / Error.
 */

interface MicPermission {
  state: 'granted' | 'denied' | 'prompt' | 'unknown'
}

function queryMicPermission(): Promise<MicPermission> {
  if (!navigator.permissions?.query) return Promise.resolve({ state: 'unknown' })
  return navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((res) => ({ state: res.state as MicPermission['state'] }))
    .catch(() => Promise.resolve({ state: 'unknown' }))
}

export function AudioDiagnosticsModal(props: { onClose: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<AudioDiagnosticsInfo | null>(null)
  const [micPermission, setMicPermission] = useState<MicPermission>({ state: 'unknown' })
  const [capture, setCapture] = useState({ ...captureDiagnostics })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    const poll = (): void => {
      void window.copilot.getAudioDiagnostics().then((i) => {
        if (live) setInfo(i)
      })
      void queryMicPermission().then((p) => {
        if (live) setMicPermission(p)
      })
      setCapture({ ...captureDiagnostics })
      setNow(Date.now())
    }
    poll()
    const t = setInterval(poll, 1_500)
    const unsub = subscribeCaptureDiagnostics(() => setCapture({ ...captureDiagnostics }))
    return () => {
      live = false
      clearInterval(t)
      unsub()
    }
  }, [])

  const session = info?.session ?? null
  const captureLive = capture.active
  const mainReceiving = (session?.metrics.chunksIn ?? 0) > 0
  const chunksRecent = capture.lastChunkAt !== null && now - capture.lastChunkAt < 2_000
  const transcribingRecently =
    (session?.metrics.sttRequests ?? 0) > 0 && session !== null && session.state === 'listening'
  const errorRecent = info?.lastError !== null && info !== null && now - Date.parse(info.lastError!.at) < 30_000

  let phase: string
  if (info === null) phase = '…'
  else if (errorRecent) phase = 'ERROR'
  else if (!captureLive && !session) phase = info.stt.label ? 'NOT STARTED' : 'PROVIDER MISSING'
  else if (session && session.state === 'listening' && captureLive && !mainReceiving)
    phase = 'WAITING FOR FIRST AUDIO'
  else if (session && session.state === 'listening' && mainReceiving && !session.speechActive)
    phase = 'LISTENING (SILENT)'
  else if (session && session.state === 'listening' && session.speechActive && !transcribingRecently)
    phase = 'RECEIVING AUDIO / SPEECH'
  else if (session && session.state === 'listening' && transcribingRecently && session.speechActive)
    phase = 'TRANSCRIBING'
  else if (session && session.state === 'paused') phase = 'PAUSED'
  else if (session) phase = `CAPTURING (${session.state})`
  else phase = 'NOT STARTED'

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="Audio diagnostics">
        <div className="row">
          <div className="section-title">Audio diagnostics</div>
          <span className="grow" />
          <span
            className={`badge ${phase.startsWith('ERROR') ? 'err' : phase === 'TRANSCRIBING' || phase.startsWith('RECEIVING') ? 'ok' : ''}`}
          >
            {phase}
          </span>
          <button className="icon" title="Close" onClick={props.onClose}>✕</button>
        </div>

        <div className="card" style={{ gap: 6 }}>
          <DiagRow label="Selected input source" value={info ? (info.configuredSource === 'mic' ? 'Microphone' : 'System audio (loopback)') : '…'} />
          <DiagRow
            label="Microphone permission"
            value={
              micPermission.state === 'unknown'
                ? 'not queryable (asked on Start)'
                : micPermission.state
            }
          />
          <DiagRow
            label="System-audio approval"
            value={
              info
                ? info.permissions.displayCaptureArmed
                  ? 'armed for the next Start'
                  : 'idle (armed when you press Start)'
                : '…'
            }
          />
          <DiagRow
            label="Renderer capture"
            value={
              captureLive
                ? `capturing${capture.source ? ` · ${capture.source === 'mic' ? 'microphone' : 'system loopback'}` : ''} · ${capture.sampleRate ?? '?'} Hz`
                : 'not started'
            }
            ok={captureLive}
          />
          <DiagRow
            label="Audio stream"
            value={
              captureLive
                ? `${capture.chunksSent} chunk(s) sent · last ${capture.lastChunkAt ? `${Math.round((now - capture.lastChunkAt) / 1000)}s ago` : 'never'}`
                : '—'
            }
            ok={captureLive && chunksRecent}
          />
          <DiagRow
            label="Main-process session"
            value={
              session
                ? `${session.purpose} · ${session.state}${session.muted ? ' · MUTED' : ''} · id ${session.id}`
                : 'none (no live session)'
            }
          />
          <DiagRow
            label="Chunks received in main"
            value={
              session
                ? `${session.metrics.chunksIn} in · ${session.metrics.chunksDropped} dropped · ${fmtStamp(session.metrics.audioMs)} of audio`
                : '—'
            }
            ok={mainReceiving}
          />
          <DiagRow label="VAD" value={session ? (session.speechActive ? 'speech detected' : 'silent') : '—'} ok={!!session?.speechActive} />
          <DiagRow
            label="STT provider"
            value={
              info
                ? info.stt.label
                  ? `${info.stt.label} (${info.stt.kind} · ${info.stt.cloudOrLocal} · lang ${info.stt.language ?? '?'})${info.stt.hasCredential ? '' : ' · NO API KEY SAVED'}`
                  : 'none configured — transcription cannot run'
                : '…'
            }
            ok={!!info?.stt.label && info.stt.hasCredential !== false}
            bad={!!info && !info.stt.label}
          />
          <DiagRow
            label="STT requests"
            value={
              session
                ? `${session.metrics.sttRequests} sent · ${session.metrics.sttErrors} failed · last RTT ${session.metrics.lastSttRttMs ?? '—'} ms`
                : '—'
            }
          />
          <DiagRow
            label="Last transcription"
            value={info?.lastSegmentAt ? new Date(info.lastSegmentAt).toLocaleTimeString() : 'never in this app run'}
          />
          <DiagRow
            label="Last audio error"
            value={info?.lastError ? `${info.lastError.code}: ${info.lastError.message} (${new Date(info.lastError.at).toLocaleTimeString()})` : 'none'}
            bad={errorRecent}
          />
        </div>

        <div className="hint">
          Interpretation: “Listening (silent)” with a live capture means audio is flowing but no speech
          crossed the VAD threshold — check that the right source is selected and that sound is actually
          playing. “NO API KEY SAVED” means transcription will fail with an authentication error.
          Diagnostics never show transcript content or keys.
        </div>
      </div>
    </div>
  )
}

function DiagRow(props: { label: string; value: string; ok?: boolean; bad?: boolean }): React.JSX.Element {
  return (
    <div className="row" style={{ alignItems: 'baseline' }}>
      <span style={{ width: 158, flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{props.label}</span>
      <span className={`badge ${props.bad ? 'err' : props.ok ? 'ok' : ''}`} style={{ whiteSpace: 'normal', textAlign: 'left' }}>
        {props.value}
      </span>
    </div>
  )
}
