import { useEffect, useRef, useState } from 'react'
import { AppSettings, ChatSendRequest } from '../../shared/protocol'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
}

/** Bound tokens sent per request; the full transcript lives in Stage 9. */
const MAX_HISTORY = 12

export function ChatPanel(props: {
  settings: AppSettings
  onOpenSettings: () => void
}): React.JSX.Element {
  const { settings, onOpenSettings } = props
  const [messages, setMessages] = useState<Msg[]>([])
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [ctxUsed, setCtxUsed] = useState<Record<string, number>>({})
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offChunk = window.copilot.onChatChunk((e) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === e.requestId ? { ...m, content: m.content + e.delta } : m))
      )
    })
    const offDone = window.copilot.onChatDone((e) => {
      setStreamingId((cur) => (cur === e.requestId ? null : cur))
    })
    const offCtx = window.copilot.onChatContext((e) => {
      setCtxUsed((prev) => ({ ...prev, [e.requestId]: e.items.length }))
    })
    const offError = window.copilot.onChatError((e) => {
      setStreamingId((cur) => (cur === e.requestId ? null : cur))
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.requestId
            ? { ...m, failed: true, content: m.content || `⚠ ${e.message}` }
            : m
        )
      )
    })
    return () => {
      offChunk()
      offDone()
      offError()
      offCtx()
    }
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const hasActiveProvider = settings.providers.some(
    (p) => p.enabled && p.id === (settings.activeProviderId ?? p.id)
  )

  const dispatch = (history: Msg[]): void => {
    const requestId = newRequestId()
    const payload: ChatSendRequest = {
      requestId,
      mode: settings.responseMode,
      messages: history
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content }))
    }
    setMessages([...history, { id: requestId, role: 'assistant', content: '' }])
    setStreamingId(requestId)
    window.copilot.sendChat(payload)
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || streamingId) return
    dispatch([...messages, { id: newRequestId(), role: 'user', content: text }])
    setInput('')
  }

  const regenerate = (assistantMsgId: string): void => {
    if (streamingId) return
    const idx = messages.findIndex((m) => m.id === assistantMsgId)
    if (idx <= 0) return
    dispatch(messages.slice(0, idx))
  }

  const stop = (): void => {
    if (streamingId) window.copilot.cancelChat(streamingId)
  }

  return (
    <div className="chat">
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            {hasActiveProvider ? (
              <>Ask anything. Ctrl+Alt+C shows or hides this window.</>
            ) : (
              <>
                <button className="secondary" onClick={onOpenSettings}>Configure a provider</button> to start.
              </>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.content || (streamingId === m.id ? '…' : '')}
            {m.failed && <div className="error-text">Request failed. Check Settings → provider.</div>}
            {m.role === 'assistant' && m.content && streamingId !== m.id && (
              <div className="meta">
                <button onClick={() => void navigator.clipboard.writeText(m.content)}>Copy</button>
                <button onClick={() => regenerate(m.id)}>Regenerate</button>
              {ctxUsed[m.id] !== undefined && (
                <button
                  title="Context sources attached to this request"
                  onClick={() => onOpenSettings()}
                >
                  ctx: {ctxUsed[m.id]} source(s)
                </button>
              )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder={streamingId ? 'Generating… (Stop to cancel)' : 'Type a question…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {streamingId ? (
          <button className="secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}

function newRequestId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
