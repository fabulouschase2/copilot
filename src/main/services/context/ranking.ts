/**
 * Lightweight lexical retrieval ranking (Module C/H).
 *
 * Deterministic, dependency-free, embedding-free. IDF-weighted term overlap
 * with an exact-phrase bonus, source-type prior, and optional recency boost —
 * deliberately better than substring matching, deliberately cheaper than a
 * vector database. Every included item carries a human-readable reason and
 * deterministic tie-breaking, so ranking is fully reproducible.
 *
 * Honesty note: ranking quality is evaluated in tests/perf-stage7.test.ts
 * against a small labeled set; results are reported, never assumed.
 */

export type RankableType = 'document' | 'profile' | 'transcript' | 'screen'

export interface RankableItem {
  itemId: string
  sourceId: string
  type: RankableType
  displayName: string
  text: string
  updatedAt: number
  sessionId?: string
}

export interface RankOptions {
  /** Per-type prior weights; profile facts are few and user-curated. */
  typeWeights?: Partial<Record<RankableType, number>>
  /** Boost multiplier for items updated within this window (ms). */
  recencyWindowMs?: number
  recencyBoost?: number
  minScore?: number
  maxItems?: number
  /** Absolute cap on selected characters after ranking. */
  maxTotalChars?: number
  /** Per-item character cap (truncates long texts before ranking output). */
  perItemCharBudget?: number
  now?: number
}

export interface RankedItem extends RankableItem {
  /** Raw score before normalization. */
  rawScore: number
  /** 0..1 normalized against the best score in this query. */
  score: number
  reason: string
  matchedTerms: string[]
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'at', 'by', 'it', 'this', 'that', 'as', 'from',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'do', 'does',
  'did', 'my', 'our', 'your', 'their', 'its', 'i', 'we', 'you', 'they', 'me',
  'us', 'them', 'can', 'could', 'should', 'would', 'will', 'shall', 'may'
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-öø-ÿ\u4e00-\u9fff\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** IDF over the candidate corpus; rare terms matter more. */
function idfMap(items: RankableItem[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const item of items) {
    const seen = new Set(tokenize(item.text))
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = new Map<string, number>()
  const n = Math.max(1, items.length)
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / (1 + d)) + 0.1)
  return idf
}

function phraseBonus(text: string, query: string): number {
  const lowerText = text.toLowerCase()
  const phrase = query.toLowerCase().trim()
  if (phrase.length >= 8 && lowerText.includes(phrase)) return 0.35
  return 0
}

/**
 * Rank candidates for a query. Deterministic order:
 * score desc → type weight desc → updatedAt desc → sourceId asc → itemId asc.
 */
export function rank(query: string, items: RankableItem[], opts: RankOptions = {}): RankedItem[] {
  if (items.length === 0) return []
  const typeWeights: Record<string, number> = {
    profile: 1.15,
    document: 1.0,
    transcript: 0.9,
    screen: 0.85,
    ...(opts.typeWeights ?? {})
  }
  const recencyWindowMs = opts.recencyWindowMs ?? 10 * 60_000
  const recencyBoost = opts.recencyBoost ?? 1.25
  const minScore = opts.minScore ?? 0.05
  const now = opts.now ?? Date.now()
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const idf = idfMap(items)
  const querySet = new Set(queryTerms)

  const scored = items.map((item) => {
    const terms = tokenize(item.text)
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)

    let overlap = 0
    const matched: string[] = []
    for (const qt of querySet) {
      const f = tf.get(qt)
      if (f) {
        // saturating term frequency, weighted by IDF
        overlap += idf.get(qt)! * (f / (f + 1.2))
        matched.push(qt)
      }
    }
    const coverage = querySet.size > 0 ? matched.length / querySet.size : 0
    let raw = overlap * (0.5 + 0.5 * coverage)
    raw += phraseBonus(item.text, query)
    raw *= typeWeights[item.type] ?? 1
    if (now - item.updatedAt <= recencyWindowMs) raw *= recencyBoost

    return { item, raw, matched }
  })

  const maxRaw = Math.max(...scored.map((s) => s.raw), Number.EPSILON)
  const ranked: RankedItem[] = scored
    .map(({ item, raw, matched }) => ({
      ...item,
      rawScore: raw,
      score: Math.round((raw / maxRaw) * 1000) / 1000,
      matchedTerms: matched,
      reason: ''
    }))
    .filter((r) => r.score >= minScore)
    .sort(
      (a, b) =>
        b.rawScore - a.rawScore ||
        (typeWeights[b.type] ?? 1) - (typeWeights[a.type] ?? 1) ||
        b.updatedAt - a.updatedAt ||
        (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) ||
        (a.itemId < b.itemId ? -1 : 1)
    )

  // Near-duplicate suppression: keep the highest-ranked of any textually
  // identical item pair (differing sources may carry the same fact).
  const kept: RankedItem[] = []
  const keptNorms: string[] = []
  for (const r of ranked) {
    const norm = normalizeForDup(r.text)
    if (keptNorms.includes(norm)) continue
    kept.push(r)
    keptNorms.push(norm)
  }

  // Budgets + reasons.
  const perItem = opts.perItemCharBudget ?? Number.MAX_SAFE_INTEGER
  let totalChars = 0
  const final: RankedItem[] = []
  for (const r of kept) {
    const text = r.text.length > perItem ? `${r.text.slice(0, perItem)}…` : r.text
    const cost = text.length
    if (opts.maxTotalChars !== undefined && totalChars + cost > opts.maxTotalChars) continue
    totalChars += cost
    const why: string[] = []
    why.push(`matched ${r.matchedTerms.length} query term(s): ${r.matchedTerms.slice(0, 5).join(', ') || '—'}`)
    why.push(`source=${r.displayName} (${r.type})`)
    if (now - r.updatedAt <= recencyWindowMs) why.push('recent')
    why.push(`score=${r.score}`)
    final.push({ ...r, text, reason: why.join('; ') })
    if (opts.maxItems !== undefined && final.length >= opts.maxItems) break
  }
  return final
}

function normalizeForDup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Render ranked items as an attributed context block for prompts. */
export function renderContextBlock(items: RankedItem[]): string {
  if (items.length === 0) return ''
  const lines = items.map((i) => `[${i.type}] (${i.sourceId}) ${i.displayName}: ${i.text}`)
  return (
    'Relevant user-approved context (traceable; cite the source name when you use it):\n' +
    lines.join('\n')
  )
}

/** Rough token estimate for budget accounting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
