/**
 * Private overlay controls (Phase 6).
 *
 * The panel deliberately separates *intent* (toggles) from *evidence* (the
 * OS-reported display affinity) so the UI can never imply privacy that the
 * operating system has not confirmed.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, OverlaySetRequest, OverlaySettings, OverlayStateInfo } from '../../shared/protocol'

interface Props {
  settings: AppSettings
  onOverlayChange: (overlay: OverlaySettings) => void
}

function stateLabel(s: OverlayStateInfo | null): { text: string; tone: string } {
  if (!s) return { text: 'Checking…', tone: 'dim' }
  if (s.support !== 'supported') return { text: 'Capture exclusion unavailable', tone: 'warn' }
  if (s.exclusionActive) return { text: 'Excluded from capture (verified)', tone: 'ok' }
  if (s.exclusionUnverified) return { text: 'Exclusion was not applied', tone: 'err' }
  return { text: 'Capturable (visible in shares)', tone: 'dim' }
}

export function OverlayPanel({ settings, onOverlayChange }: Props): React.JSX.Element {
  const [state, setState] = useState<OverlayStateInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.copilot.getOverlayState().then(setState)
    return window.copilot.onOverlayState((e) => setState(e))
  }, [])

  const apply = useCallback(
    async (patch: OverlaySetRequest): Promise<void> => {
      setBusy(true)
      try {
        const next = await window.copilot.setOverlay(patch)
        setState(next)
        onOverlayChange({
          enabled: next.enabled,
          captureExcluded: next.captureExcluded,
          opacity: next.opacity,
          fontSize: next.fontSize,
          showCaptions: next.showCaptions
        })
      } finally {
        setBusy(false)
      }
    },
    [onOverlayChange]
  )

  const overlay = settings.overlay
  const label = stateLabel(state)
  const affinityHex =
    state?.affinity === null || state?.affinity === undefined
      ? 'not read'
      : `0x${state.affinity.toString(16).padStart(2, '0')}`

  return (
    <div className="overlay-panel">
      <div className="section-title">Private overlay</div>
      <p className="hint">
        A separate floating window that stays visible on your display. On Windows 10 (2004+) and
        Windows 11 the window can be excluded from screen capture, so recorders and screen shares
        show the application behind it instead of your notes.
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Overlay window</div>
            <div className="hint">Ctrl+Alt+O toggles it from anywhere.</div>
          </div>
          <button
            className={overlay.enabled ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => void apply({ enabled: !overlay.enabled })}
          >
            {overlay.enabled ? 'On' : 'Off'}
          </button>
        </div>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Exclude from screen capture</div>
            <div className="hint">Applies only to the overlay window, never to other apps.</div>
          </div>
          <button
            className={overlay.captureExcluded ? 'primary' : 'secondary'}
            disabled={busy || state?.support !== 'supported'}
            title={state?.support !== 'supported' ? (state?.supportMessage ?? '') : ''}
            onClick={() => void apply({ captureExcluded: !overlay.captureExcluded })}
          >
            {overlay.captureExcluded ? 'On' : 'Off'}
          </button>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <span className={`badge ${label.tone === 'dim' ? '' : label.tone}`}>{label.text}</span>
          <span className="hint">OS affinity: {affinityHex}</span>
        </div>

        {state?.error && <div className="error-text" style={{ marginTop: 8 }}>{state.error}</div>}
        {state && state.support !== 'supported' && (
          <div className="hint" style={{ marginTop: 8 }}>
            {state.supportMessage}
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600 }}>Show live captions</span>
          <button
            className={overlay.showCaptions ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => void apply({ showCaptions: !overlay.showCaptions })}
          >
            {overlay.showCaptions ? 'On' : 'Off'}
          </button>
        </div>

        <div style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Font size</span>
            <span className="hint">{overlay.fontSize}px</span>
          </div>
          <input
            type="range"
            min={11}
            max={28}
            step={1}
            value={overlay.fontSize}
            disabled={busy}
            onChange={(e) => void apply({ fontSize: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Opacity</span>
            <span className="hint">{Math.round(overlay.opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={25}
            max={100}
            step={1}
            value={Math.round(overlay.opacity * 100)}
            disabled={busy}
            onChange={(e) => void apply({ opacity: Number(e.target.value) / 100 })}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>What this does and does not do</div>
        <ul className="hint" style={{ margin: '6px 0 0 16px', padding: 0, lineHeight: 1.6 }}>
          <li>
            The overlay is excluded only when Windows confirms <code>WDA_EXCLUDEFROMCAPTURE</code>.
            The badge above shows that confirmation, not the setting you asked for.
          </li>
          <li>
            Excluding a window is not the same as hiding it. Anyone physically looking at your
            screen still sees it.
          </li>
          <li>
            Many recorders honour Windows capture exclusion; some capture methods (certain capture
            cards, cameras pointed at the screen, some older tools) cannot. Verify with the tool
            you actually use.
          </li>
          <li>Screen sharing of the entire desktop may still reveal it, depending on the browser.</li>
          <li>
            Copilot does not record, transmit or store screen content, and does not attempt to evade
            proctoring, monitoring or assessment controls. Follow your meeting and workplace rules.
          </li>
        </ul>
      </div>
    </div>
  )
}
