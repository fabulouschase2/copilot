import type { ReactNode } from 'react'

/** Small shared presentational building blocks used across views. */

export function Spinner(): React.JSX.Element {
  return <span className="spinner" aria-label="Loading" />
}

export function LoadingRow(props: { label: string }): React.JSX.Element {
  return (
    <div className="loading-row">
      <Spinner />
      <span>{props.label}</span>
    </div>
  )
}

export function EmptyState(props: { title: string; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      <div>{props.title}</div>
      {props.children}
    </div>
  )
}

export function ScoreRow(props: { name: string; score: number }): React.JSX.Element {
  const clamped = Math.min(5, Math.max(1, Math.round(props.score)))
  return (
    <div className="score-row">
      <span className="score-name">{props.name}</span>
      <span className="score-bar">
        <span className={`score-fill s${clamped}`} style={{ width: `${(clamped / 5) * 100}%` }} />
      </span>
      <span className="score-num">{clamped}</span>
    </div>
  )
}

export function ErrorBox(props: { children: ReactNode }): React.JSX.Element {
  return <div className="error-box">{props.children}</div>
}

export function NoticeBox(props: { children: ReactNode }): React.JSX.Element {
  return <div className="notice-box">{props.children}</div>
}

/** "x minutes ago"-style compact relative time for list rows. */
export function shortTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** mm:ss wall-clock stamp from a segment's session-relative ms. */
export function fmtStamp(ms: number): string {
  return fmtDuration(Math.max(0, ms))
}
