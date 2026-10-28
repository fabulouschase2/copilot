import type { ReactNode } from 'react'

/**
 * Minimal answer renderer: preserves code fences as monospace blocks and
 * everything else as pre-wrapped text. No markdown dependency added.
 */
export function renderAnswer(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // fenced block: first line may be a language tag
      const nl = part.indexOf('\n')
      const lang = nl > 0 && nl < 20 ? part.slice(0, nl).trim() : ''
      const code = nl > 0 ? part.slice(nl + 1) : part
      out.push(
        <pre key={`c${i}`} className="code-block" data-lang={lang || undefined}>
          {code.replace(/\n$/, '')}
        </pre>
      )
    } else if (part.trim().length > 0) {
      out.push(
        <span key={`t${i}`} className="answer-text">
          {part}
        </span>
      )
    }
  })
  return out
}
