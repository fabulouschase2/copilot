/**
 * Career Story Bank (Phase 2).
 *
 * Every story is written or reviewed by the user. "Draft from profile facts"
 * fills the editor with a model draft; it never saves anything, and the banner
 * stays visible so an unreviewed draft cannot pass as the user's own story.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  CareerStory,
  StoryFramework,
  StoryUpsertRequest
} from '../../shared/protocol'
import { STORY_FRAMEWORK_FIELDS } from '../../shared/protocol'

interface Props {
  settings: AppSettings
}

interface FormState {
  title: string
  framework: StoryFramework
  role: string
  skillsText: string
  situation: string
  task: string
  action: string
  result: string
  answerFirst: string
}

const EMPTY_FORM: FormState = {
  title: '',
  framework: 'star',
  role: '',
  skillsText: '',
  situation: '',
  task: '',
  action: '',
  result: '',
  answerFirst: ''
}

function toForm(story: CareerStory): FormState {
  return {
    title: story.title,
    framework: story.framework,
    role: story.role,
    skillsText: story.skills.join(', '),
    situation: story.situation,
    task: story.task,
    action: story.action,
    result: story.result,
    answerFirst: story.answerFirst
  }
}

export function StoryPanel({ settings }: Props): React.JSX.Element {
  const [stories, setStories] = useState<CareerStory[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [draftBanner, setDraftBanner] = useState<string | null>(null)
  const [focus, setFocus] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.copilot.listStories()
    setStories(res.stories)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return stories
    return stories.filter((s) =>
      [s.title, s.role, s.skills.join(' '), s.situation, s.action, s.result]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [stories, query])

  const startNew = (): void => {
    setForm({ ...EMPTY_FORM })
    setEditingId(null)
    setDraftBanner(null)
    setMessage(null)
  }

  const startEdit = (story: CareerStory): void => {
    setForm(toForm(story))
    setEditingId(story.storyId)
    setDraftBanner(null)
    setMessage(null)
  }

  const save = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setMessage(null)
    try {
      const req: StoryUpsertRequest = {
        ...(editingId ? { storyId: editingId } : {}),
        title: form.title,
        framework: form.framework,
        role: form.role,
        skills: form.skillsText
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        situation: form.situation,
        task: form.task,
        action: form.action,
        result: form.result,
        answerFirst: form.answerFirst
      }
      const res = await window.copilot.upsertStory(req)
      if (!res.ok) {
        setMessage({ tone: 'err', text: res.message ?? 'Could not save the story.' })
        return
      }
      setMessage({ tone: 'ok', text: 'Story saved.' })
      setDraftBanner(null)
      if (res.story) setEditingId(res.story.storyId)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (storyId: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.copilot.deleteStory(storyId)
      if (!res.ok) {
        setMessage({ tone: 'err', text: 'Could not delete that story.' })
        return
      }
      if (editingId === storyId) {
        setForm(null)
        setEditingId(null)
      }
      setConfirmDelete(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const draft = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.copilot.draftStory({ framework: form.framework, focus })
      if (!res.ok || !res.draft) {
        setMessage({ tone: 'err', text: res.message ?? 'Could not draft a story.' })
        return
      }
      setForm({
        title: res.draft.title,
        framework: res.draft.framework,
        role: res.draft.role,
        skillsText: res.draft.skills.join(', '),
        situation: res.draft.situation,
        task: res.draft.task,
        action: res.draft.action,
        result: res.draft.result,
        answerFirst: res.draft.answerFirst
      })
      setDraftBanner(
        `AI draft${res.providerLabel ? ` from ${res.providerLabel}` : ''} — built only from your confirmed facts. Review and edit before saving.`
      )
    } finally {
      setBusy(false)
    }
  }

  const fields = form ? (STORY_FRAMEWORK_FIELDS[form.framework] ?? STORY_FRAMEWORK_FIELDS.star) : []

  return (
    <div className="stories-panel">
      <div className="card">
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Career stories</div>
            <div className="hint">
              Reusable answers from your own experience. The Interview view automatically attaches the
              most relevant ones to your question.
            </div>
          </div>
          <button className="primary" onClick={startNew}>
            + New story
          </button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="grow"
            type="text"
            placeholder="Search stories by title, skill or content"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {stories.length === 0 && (
          <div className="hint" style={{ marginTop: 8 }}>
            No stories yet. Add one manually, or draft from the facts you confirmed in Settings.
          </div>
        )}
        {filtered.map((s) => (
          <div key={s.storyId} className="row compact" style={{ alignItems: 'flex-start' }}>
            <span className="badge">{s.framework}</span>
            <div className="grow">
              <div>{s.title}</div>
              <div className="hint">
                {[s.role, s.skills.join(', ')].filter((x) => x && x.length > 0).join(' · ')}
              </div>
            </div>
            <button className="chip" onClick={() => startEdit(s)}>
              Edit
            </button>
            {confirmDelete === s.storyId ? (
              <button className="danger" disabled={busy} onClick={() => void remove(s.storyId)}>
                Confirm
              </button>
            ) : (
              <button className="meta-btn" onClick={() => setConfirmDelete(s.storyId)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {form && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            {editingId ? 'Edit story' : 'New story'}
          </div>

          {draftBanner && (
            <div className="notice-box" style={{ marginBottom: 8 }}>
              <span className="hint">{draftBanner}</span>
            </div>
          )}

          <div className="row wrap">
            <input
              className="grow"
              type="text"
              placeholder="Story title (e.g. Cut build times by 40%)"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <select
              value={form.framework}
              onChange={(e) => setForm({ ...form, framework: e.target.value as StoryFramework })}
            >
              <option value="star">STAR</option>
              <option value="car">CAR</option>
              <option value="par">PAR</option>
              <option value="soar">SOAR</option>
              <option value="answer-first">Answer-first</option>
            </select>
          </div>

          <div className="row wrap" style={{ marginTop: 6 }}>
            <input
              className="grow"
              type="text"
              placeholder="Role / employer (optional)"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
            <input
              className="grow"
              type="text"
              placeholder="Skills, comma separated"
              value={form.skillsText}
              onChange={(e) => setForm({ ...form, skillsText: e.target.value })}
            />
          </div>

          {fields.map((field) => {
            const value = form[field.key]
            return (
              <div key={field.key} style={{ marginTop: 6 }}>
                <div className="hint">{field.label}</div>
                <textarea
                  className="grow"
                  style={{ width: '100%', minHeight: field.key === 'action' ? 72 : 48 }}
                  value={value}
                  onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  placeholder={
                    field.key === 'result' ? 'Only include results you can actually support.' : ''
                  }
                />
              </div>
            )
          })}

          <div className="row wrap" style={{ marginTop: 8 }}>
            <input
              className="grow"
              type="text"
              placeholder="Draft angle (optional, e.g. conflict, leadership)"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
            />
            <button className="secondary" disabled={busy} onClick={() => void draft()}>
              {busy ? 'Working…' : 'Draft from profile facts'}
            </button>
          </div>

          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || !form.title.trim()} onClick={() => void save()}>
              Save story
            </button>
            <button
              className="ghost"
              onClick={() => {
                setForm(null)
                setEditingId(null)
                setDraftBanner(null)
              }}
            >
              Close
            </button>
            <span className="grow" />
            {editingId && (
              <button className="meta-btn" onClick={() => setConfirmDelete(editingId)}>
                {confirmDelete === editingId ? 'Click again to delete' : 'Delete story'}
              </button>
            )}
            {editingId && confirmDelete === editingId && (
              <button className="danger" disabled={busy} onClick={() => void remove(editingId)}>
                Confirm delete
              </button>
            )}
          </div>

          {message && (
            <div className={message.tone === 'ok' ? 'hint' : 'error-text'} style={{ marginTop: 6 }}>
              {message.text}
            </div>
          )}

          <div className="hint" style={{ marginTop: 6 }}>
            Stories are scoped to the active profile{settings.activeProfileId !== 'default' ? '' : ' (Default)'}.
            Nothing is invented: leave a field empty if you cannot support it.
          </div>
        </div>
      )}
    </div>
  )
}
