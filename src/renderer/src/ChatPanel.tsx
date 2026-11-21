import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  ChatSendRequest,
  ConversationSummary
} from '../../shared/protocol'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
}

/** Bound tokens sent per request; the stored transcript is unbounded. */
const MAX_HISTORY = 12

function newRequestId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function formatWhen(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const diffMs = Date.now() - then.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString()
}

/**
 * Chat with persisted conversations (0.5.0).
 *
 * History lives in SQLite and is scoped to the active profile. A conversation is
 * created on the first message and named from it, so saving never depends on a
 * provider being available.
 */
export function ChatPanel(props: {
  settings: AppSettings
  onOpenSettings: () => void
}): React.JSX.Element {
  const { settings, onOpenSettings } = props
  const [messages, setMessages] = useState<Msg[]>([])
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [ctxUsed, setCtxUsed] = useState<Record<string, number>>({})
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversationTitle, setConversationTitle] = useState('New conversation')
  const [showHistory, setShowHistory] = useState(false)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Msg[]>([])
  const conversationIdRef = useRef<string | null>(null)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  const refreshConversations = useCallback(async (): Promise<void> => {
    const res = await window.copilot.listConversations({ query, includeArchived })
    setConversations(res.conversations)
  }, [query, includeArchived])

  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  useEffect(() => {
    const offChunk = window.copilot.onChatChunk((e) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === e.requestId ? { ...m, content: m.content + e.delta } : m))
      )
    })
    const offDone = window.copilot.onChatDone((e) => {
      setStreamingId((cur) => (cur === e.requestId ? null : cur))
      // Persist the finished answer (never a partial one).
      const finished = messagesRef.current.find((m) => m.id === e.requestId)
      const conv = conversationIdRef.current
      if (conv && finished && finished.content.trim().length > 0) {
        void window.copilot
          .appendConversationMessage({ conversationId: conv, role: 'assistant', content: finished.content })
          .then(() => refreshConversations())
      }
    })
    const offCtx = window.copilot.onChatContext((e) => {
      setCtxUsed((prev) => ({ ...prev, [e.requestId]: e.items.length }))
    })
    const offError = window.copilot.onChatError((e) => {
      setStreamingId((cur) => (cur === e.requestId ? null : cur))
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.requestId ? { ...m, failed: true, content: m.content || `⚠ ${e.message}` } : m
        )
      )
    })
    return () => {
      offChunk()
      offDone()
      offError()
      offCtx()
    }
  }, [refreshConversations])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const hasActiveProvider = settings.providers.some((p) => p.enabled)

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

  const ensureConversation = async (firstText: string): Promise<string | null> => {
    if (conversationId) return conversationId
    const res = await window.copilot.createConversation({ title: firstText.slice(0, 80) })
    if (!res.ok || !res.conversation) {
      setNotice(res.message ?? 'Could not start a conversation.')
      return null
    }
    setConversationId(res.conversation.conversationId)
    setConversationTitle(res.conversation.title)
    void refreshConversations()
    return res.conversation.conversationId
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streamingId) return
    const conv = await ensureConversation(text)
    if (!conv) return
    await window.copilot.appendConversationMessage({ conversationId: conv, role: 'user', content: text })
    dispatch([...messages, { id: newRequestId(), role: 'user', content: text }])
    setInput('')
    setNotice(null)
    void refreshConversations()
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

  const openConversation = async (id: string): Promise<void> => {
    const detail = await window.copilot.getConversation(id)
    if (!detail) {
      setNotice('That conversation could not be loaded.')
      return
    }
    setConversationId(detail.conversationId)
    setConversationTitle(detail.title)
    setMessages(
      detail.messages.map((m) => ({ id: m.messageId, role: m.role, content: m.content }))
    )
    setShowHistory(false)
    setNotice(null)
  }

  const startNew = (): void => {
    setConversationId(null)
    setConversationTitle('New conversation')
    setMessages([])
    setShowHistory(false)
    setNotice(null)
  }

  const doRename = async (): Promise<void> => {
    if (!renaming) return
    const title = renaming.title.trim()
    if (!title) return
    await window.copilot.renameConversation({ conversationId: renaming.id, title })
    if (renaming.id === conversationId) setConversationTitle(title)
    setRenaming(null)
    void refreshConversations()
  }

  return (
    <div className="chat">
      <div className="row" style={{ padding: '4px 6px', gap: 6, borderBottom: '1px solid var(--border)' }}>
        <button
          className={`chip ${showHistory ? 'chip-active' : ''}`}
          title="Conversation history"
          onClick={() => setShowHistory((v) => !v)}
        >
          ☰ History
        </button>
        <button className="chip" onClick={startNew} title="Start a new conversation">
          + New
        </button>
        <span className="grow" />
        <span className="hint" title={conversationTitle} style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {conversationTitle}
        </span>
      </div>

      {showHistory && (
        <div className="conv-list">
          <div className="row" style={{ gap: 4 }}>
            <input
              className="grow"
              type="text"
              placeholder="Search conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="hint" title="Include archived">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />{' '}
              archive
            </label>
          </div>
          {conversations.length === 0 && <div className="hint">No saved conversations yet.</div>}
          {conversations.map((c) => (
            <div key={c.conversationId} className="conv-item">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <button className="conv-open" onClick={() => void openConversation(c.conversationId)}>
                  <span className="conv-title">
                    {c.pinned ? '📌 ' : ''}
                    {c.title}
                  </span>
                  <span className="hint">
                    {formatWhen(c.updatedAt)} · {c.messageCount} message(s)
                    {c.archived ? ' · archived' : ''}
                  </span>
                  {c.preview && <span className="conv-preview">{c.preview}</span>}
                </button>
              </div>
              <div className="row" style={{ gap: 2 }}>
                <button
                  className="meta-btn"
                  title={c.pinned ? 'Unpin' : 'Pin'}
                  onClick={() =>
                    void window.copilot
                      .pinConversation({ conversationId: c.conversationId, pinned: !c.pinned })
                      .then(refreshConversations)
                  }
                >
                  {c.pinned ? 'unpin' : 'pin'}
                </button>
                <button
                  className="meta-btn"
                  onClick={() => setRenaming({ id: c.conversationId, title: c.title })}
                >
                  rename
                </button>
                <button
                  className="meta-btn"
                  onClick={() =>
                    void window.copilot
                      .archiveConversation({ conversationId: c.conversationId, archived: !c.archived })
                      .then(refreshConversations)
                  }
                >
                  {c.archived ? 'restore' : 'archive'}
                </button>
                {confirmDelete === c.conversationId ? (
                  <button
                    className="meta-btn danger"
                    onClick={() =>
                      void window.copilot.deleteConversation(c.conversationId).then(() => {
                        setConfirmDelete(null)
                        if (conversationId === c.conversationId) startNew()
                        void refreshConversations()
                      })
                    }
                  >
                    confirm delete
                  </button>
                ) : (
                  <button className="meta-btn" onClick={() => setConfirmDelete(c.conversationId)}>
                    delete
                  </button>
                )}
              </div>
              {renaming?.id === c.conversationId && (
                <div className="row">
                  <input
                    className="grow"
                    type="text"
                    value={renaming.title}
                    onChange={(e) => setRenaming({ id: c.conversationId, title: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && void doRename()}
                  />
                  <button className="chip" onClick={() => void doRename()}>
                    save
                  </button>
                  <button className="meta-btn" onClick={() => setRenaming(null)}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            {hasActiveProvider ? (
              <>Ask anything. Conversations are saved automatically and can be reopened.</>
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
                  <button title="Context sources attached to this request" onClick={onOpenSettings}>
                    ctx: {ctxUsed[m.id]} source(s)
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {notice && <div className="error-text" style={{ padding: '0 8px' }}>{notice}</div>}

      <div className="composer">
        <textarea
          value={input}
          placeholder={streamingId ? 'Generating… (Stop to cancel)' : 'Type a question…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {streamingId ? (
          <button className="secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
