import { useState } from 'react'
import { saveCredential } from '../../shared/credentials'

/**
 * Password field + explicit Save key control for provider API keys
 * (chat and transcription providers share it).
 *
 * Contract (v0.2.3 key-management fix):
 *  - saves ONLY on the Save key click — never onBlur
 *  - awaits setCredential; clears the input only on success
 *  - shows Saved / Save failed feedback (never echoes the secret)
 *  - Show/Hide toggle; hasCredential badge without revealing the key
 *  - the secret lives only in this component's state and the IPC call
 */
export function KeyField(props: {
  providerId: string
  hasCredential: boolean
  /** Parent refreshes the hasCredential badge after a successful save. */
  onSaved: () => void
}): React.JSX.Element {
  const { providerId, hasCredential, onSaved } = props
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFeedback(null)
    const result = await saveCredential(providerId, value, window.copilot.setCredential)
    setFeedback({ ok: result.ok, text: result.message })
    if (result.ok) {
      setValue('')
      setShow(false)
      onSaved()
    }
    setBusy(false)
  }

  return (
    <span className="row compact" style={{ borderBottom: 'none', flexWrap: 'wrap' }}>
      <input
        type={show ? 'text' : 'password'}
        placeholder="API key"
        style={{ width: 150 }}
        value={value}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
        aria-label={`API key for ${providerId}`}
      />
      <button
        className="meta-btn"
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide key' : 'Show key'}
        aria-label={show ? 'Hide API key' : 'Show API key'}
      >
        {show ? '🙈' : '👁'}
      </button>
      <button className="secondary" disabled={busy || value.trim().length === 0} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save key'}
      </button>
      <span className={`badge ${hasCredential ? 'ok' : ''}`} title={hasCredential ? 'A key is saved (OS-encrypted)' : 'No key saved yet'}>
        {hasCredential ? 'key saved' : 'no key'}
      </span>
      {feedback && <span className={`badge ${feedback.ok ? 'ok' : 'err'}`}>{feedback.text}</span>}
    </span>
  )
}
