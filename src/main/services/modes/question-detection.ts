/**
 * Interview question detection (Module E) — pure and deterministic.
 *
 * Heuristic, conservative: a sentence is a likely question only when it ends
 * with a question mark OR opens with an interrogative/interview pattern.
 * Mid-sentence interrogative words do NOT qualify, which filters the most
 * common false positives ("I don't know what to do", "Here's what happened").
 */

export interface DetectedQuestion {
  text: string
  confidence: 'high' | 'medium'
  kind: 'behavioral' | 'technical' | 'general'
}

/** Sentence openers that indicate a question even without a trailing '?'. */
const INTERROGATIVE_OPENERS = [
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whose',
  'could you', 'can you', 'would you', 'will you', 'do you', 'did you',
  'have you', 'are you', 'is there', 'are there',
  'tell me', 'describe', 'walk me through', 'give an example',
  'explain', 'imagine', 'suppose'
]

/** Patterns that mark a question as behavioral/STAR-oriented. */
const BEHAVIORAL_MARKERS = [
  'tell me about a time', 'describe a situation', 'describe a time',
  'walk me through a', 'give an example of a time', 'have you ever had to',
  'how did you handle', 'how do you handle', 'a time when', 'conflict',
  'disagreement', 'challenging', 'failure', 'mistake', 'leadership',
  'feedback', 'deadl', 'priorit', 'stakeholder'
]

/** Markers that suggest a technical question. */
const TECHNICAL_MARKERS = [
  'algorithm', 'complexity', 'big o', 'optimize', 'implement', 'design a system',
  'system design', 'debug', 'race condition', 'memory', 'database', 'index',
  'api', 'concurrency', 'thread', 'cache', 'scal', 'protocol', 'refactor',
  'typescript', 'javascript', 'python', 'rust', 'java', 'sql', 'react',
  'architecture', 'test', 'regression', 'deploy', 'security', 'encryption'
]

/** Sentences that merely CONTAIN a question word are not questions. */
const NEGATIVE_PREFIXES = [
  "i don't know", 'i am not sure', "i'm not sure", 'not sure what',
  'here is what', "here's what", 'that is what', "that's what",
  'this is what', 'i think what', 'let me tell you what', 'you know what',
  'i wonder what', 'it shows what', 'we discussed what'
]

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Leading discourse markers that hide a question opener ("Then tell me…"). */
const DISCOURSE_MARKERS = /^(then|and|so|also|next|now|first|second|okay|ok|well|but)[, ]+\s*/i

function stripDiscourseMarkers(lower: string): string {
  let out = lower
  let prev = ''
  while (out !== prev) {
    prev = out
    out = out.replace(DISCOURSE_MARKERS, '')
  }
  return out.trim()
}

function classifyKind(lower: string): DetectedQuestion['kind'] {
  if (BEHAVIORAL_MARKERS.some((m) => lower.includes(m))) return 'behavioral'
  if (TECHNICAL_MARKERS.some((m) => lower.includes(m))) return 'technical'
  return 'general'
}

/**
 * Detect likely questions in free text (a transcript segment or manual
 * input). Returns one entry per qualifying sentence, in order.
 */
export function detectQuestions(text: string): DetectedQuestion[] {
  const out: DetectedQuestion[] = []
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim()
    if (trimmed.length < 8) continue
    const lower = trimmed.toLowerCase()
    if (NEGATIVE_PREFIXES.some((p) => lower.startsWith(p))) continue

    const endsWithMark = trimmed.endsWith('?')
    const stripped = stripDiscourseMarkers(lower)
    const opener = INTERROGATIVE_OPENERS.find((o) => stripped === o || stripped.startsWith(`${o} `))
    if (!endsWithMark && !opener) continue

    // Opener-only detection needs some substance after the opener to count
    // ("tell me about your testing approach" yes; "what" alone no).
    if (!endsWithMark && opener) {
      const rest = stripped.slice(opener.length).trim()
      if (rest.split(/\s+/).filter(Boolean).length < 2) continue
    }

    out.push({
      text: trimmed,
      confidence: endsWithMark ? 'high' : 'medium',
      kind: classifyKind(lower)
    })
  }
  return out
}

/** Merge consecutive segment detections: newest first, bounded. */
export function dedupeQuestions(questions: DetectedQuestion[], seen: Set<string>): DetectedQuestion[] {
  return questions.filter((q) => {
    const key = q.text.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
