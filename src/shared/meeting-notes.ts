import type { MeetingActionItem } from './protocol'

/**
 * Parse the "## Action items" section of generated meeting notes into
 * structured items. Used by the renderer to persist structured action items
 * alongside the notes text. Evidence-only: owners/deadlines are taken
 * verbatim from the lines (which the meeting prompt constrains to
 * "(not stated)" when absent).
 */
export function parseActionItems(notes: string): MeetingActionItem[] {
  const lines = notes.split('\n')
  const startIdx = lines.findIndex((l) => /^#{1,3}\s*action items/i.test(l.trim()))
  if (startIdx === -1) return []
  const items: MeetingActionItem[] = []
  for (const line of lines.slice(startIdx + 1)) {
    const trimmed = line.trim()
    if (/^#{1,3}\s/.test(trimmed)) break // next section
    if (trimmed.length === 0) continue
    const ownerMatch = trimmed.match(/—\s*Owner:\s*(.+?)(?:\s*—\s*Deadline:\s*(.+))?$/i)
    const task = trimmed
      .replace(/—\s*Owner:.*$/i, '')
      .replace(/^[-*•]\s*/, '')
      .trim()
    if (ownerMatch && task.length > 0) {
      items.push({
        task,
        owner: ownerMatch[1]?.trim() || '(not stated)',
        deadline: ownerMatch[2]?.trim() || '(not stated)',
        suggested: /^\[suggested\]/i.test(task)
      })
    } else if (items.length < 100) {
      // Unstructured line (continuation or plain bullet): no owner claimed.
      items.push({
        task: trimmed.replace(/^[-*•]\s*/, ''),
        owner: '(not stated)',
        deadline: '(not stated)',
        suggested: false
      })
    }
  }
  return items
}
