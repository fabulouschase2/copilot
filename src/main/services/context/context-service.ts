/**
 * Unified context service (Module C/H orchestrator, Stage 7).
 *
 * Retrieves a SMALL, RELEVANT, TRACEABLE set of context items per request —
 * never an automatic memory dump. Session-scoped data (transcript, screen)
 * is wiped whenever a new transcription session begins and is retrievable
 * only by the session that produced it. Documents and profile facts are
 * reused only when the corresponding category is enabled and not excluded.
 */
import { dialog, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import { ContextEngine } from '../context-engine'
import {
  ContextOptions,
  ContextPreviewRequestSchema,
  ContextSettings,
  ContextSourceInfo,
  ProfileCategory,
  ProfileFactOp,
  RetrievedItem
} from '../../../shared/protocol'
import { extractDocument, isSupportedFileName } from './document-extract'
import { extractPdfFromFile } from './pdf-extract'
import { estimateTokens, rank, renderContextBlock, RankedItem, RankableItem } from './ranking'

/** Minimal store contract so tests can substitute the file-backed store. */
export interface ContextStoreLike {
  listDocuments(): Array<{ sourceId: string; displayName: string; text: string; status: 'ready' | 'partial'; createdAt: string; updatedAt: string }>
  listFacts(profileId?: string): Array<{ factId: string; text: string; category: ProfileCategory; origin: 'user' | 'model'; createdAt: string; updatedAt: string; profileId: string }>
  isExcluded(sourceId: string, type: string): boolean
  setExcluded(sourceId: string | undefined, type: string | undefined, excluded: boolean): void
  addDocument(doc: { sourceId: string; displayName: string; text: string; status: 'ready' | 'partial'; createdAt: string; updatedAt: string }): void
  removeDocument(sourceId: string): void
  addFact(fact: { factId: string; text: string; category: ProfileCategory; origin: 'user' | 'model'; createdAt: string; updatedAt: string; profileId: string }): void
  updateFact(factId: string, patch: { text?: string; category?: ProfileCategory }): boolean
  removeFact(factId: string): boolean
  /** Profile management; supported by the SQLite store (tests may omit). */
  listProfiles?(): Array<{ profileId: string; name: string; createdAt: string; updatedAt: string }>
  upsertProfile?(profile: { profileId: string; name: string; createdAt: string; updatedAt: string }): void
  renameProfile?(profileId: string, name: string): boolean
  deleteProfile?(profileId: string): boolean
  countFacts?(profileId: string): number
}

export interface ContextDeps {
  store: ContextStoreLike
  engine: ContextEngine
  settings: () => ContextSettings
  /** Active personal profile: facts are scoped to it (transformation). */
  activeProfileId?: () => string
  /** Window used as the dialog parent; nullable in tests. */
  getWindow?: () => BrowserWindow | null
}

export interface RetrievalResult {
  items: RankedItem[]
  estimatedTokens: number
  block: string
}

export class ContextService {
  /** Session id of the ACTIVE transcription session (null between sessions). */
  private currentSessionId: string | null = null

  constructor(private deps: ContextDeps) {}

  /** Stage 9: swap the backing store (used by restore-from-backup). */
  replaceStore(store: ContextStoreLike): void {
    this.deps.store = store
  }

  /* ── session boundaries ─────────────────────────────────────────────── */

  /** Called when a new transcription session is prepared. */
  beginSession(sessionId: string): void {
    // Hard reset: transcript/screen items from the previous session can
    // never leak into the new one.
    this.deps.engine.clearSessionScoped()
    this.currentSessionId = sessionId
  }

  /** Called when the transcription session stops. */
  endSession(): void {
    this.currentSessionId = null
  }

  get sessionId(): string | null {
    return this.currentSessionId
  }

  clearSessionContext(): void {
    this.deps.engine.clearSessionScoped()
  }

  /* ── documents ──────────────────────────────────────────────────────── */

  /** Opens the file dialog in the main process; the renderer never sees paths. */
  async importDocuments(): Promise<Array<{ sourceId: string; displayName: string; status: string; extractedChars: number; message?: string }>> {
    const win = this.deps.getWindow?.() ?? null
    const picked = await dialog.showOpenDialog(win ?? (undefined as never), {
      title: 'Import documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Resume & documents (PDF, TXT, MD)', extensions: ['pdf', 'txt', 'md', 'markdown'] }
      ]
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    const results: Array<{ sourceId: string; displayName: string; status: string; extractedChars: number; message?: string }> = []
    for (const filePath of picked.filePaths.slice(0, 20)) {
      const displayName = filePath.replace(/^.*[/\\]/, '')
      if (displayName.toLowerCase().endsWith('.pdf')) {
        // PDFs need their own async extractor (binary parsing, page-bounded).
        const pdfResult = await extractPdfFromFile(filePath)
        if (pdfResult.status === 'failed') {
          results.push({
            sourceId: `doc-${Date.now().toString(36)}`,
            displayName,
            status: 'failed',
            extractedChars: 0,
            message: pdfResult.message
          })
          continue
        }
        const sourceId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const now = new Date().toISOString()
        this.deps.store.addDocument({
          sourceId,
          displayName,
          text: pdfResult.text,
          status: pdfResult.status === 'partial' ? 'partial' : 'ready',
          createdAt: now,
          updatedAt: now
        })
        results.push({
          sourceId,
          displayName,
          status: pdfResult.status,
          extractedChars: pdfResult.text.length,
          message: pdfResult.pages ? `${pdfResult.pages} pages` : undefined
        })
        continue
      }
      const result = await this.importOne(displayName, () => fs.promises.readFile(filePath))
      results.push(result)
    }
    return results
  }

  /** Testable single-file import: the reader is injectable. */
  async importOne(
    displayName: string,
    read: () => Promise<Buffer>
  ): Promise<{ sourceId: string; displayName: string; status: string; extractedChars: number; message?: string }> {
    const sourceId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!isSupportedFileName(displayName)) {
      return { sourceId, displayName, status: 'failed', extractedChars: 0, message: 'Unsupported format' }
    }
    try {
      const buf = await read()
      const extraction = extractDocument(displayName, new Uint8Array(buf))
      if (extraction.status === 'failed') {
        return { sourceId, displayName, status: 'failed', extractedChars: 0, message: extraction.message }
      }
      const now = new Date().toISOString()
      this.deps.store.addDocument({
        sourceId,
        displayName,
        text: extraction.text,
        status: extraction.status,
        createdAt: now,
        updatedAt: now
      })
      return { sourceId, displayName, status: extraction.status, extractedChars: extraction.text.length }
    } catch (err) {
      return {
        sourceId,
        displayName,
        status: 'failed',
        extractedChars: 0,
        message: err instanceof Error ? err.message : 'Could not read file'
      }
    }
  }

  removeDocument(sourceId: string): void {
    this.deps.store.removeDocument(sourceId)
  }

  /** Upsert the job description as a dedicated ranked document. */
  setJobDescription(text: string): void {
    const trimmed = text.trim()
    this.deps.store.removeDocument('job-description')
    if (trimmed.length === 0) return
    const now = new Date().toISOString()
    this.deps.store.addDocument({
      sourceId: 'job-description',
      displayName: 'Job Description',
      text: trimmed,
      status: 'ready',
      createdAt: now,
      updatedAt: now
    })
  }

  /* ── profile ────────────────────────────────────────────────────────── */

  /** Facts belong to the ACTIVE personal profile. */
  private get profileId(): string {
    return this.deps.activeProfileId?.() ?? 'default'
  }

  applyProfileOp(op: ProfileFactOp): { ok: boolean; message?: string } {
    switch (op.op) {
      case 'add': {
        const now = new Date().toISOString()
        this.deps.store.addFact({
          factId: `fact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          text: op.text,
          category: op.category,
          origin: 'user',
          createdAt: now,
          updatedAt: now,
          profileId: this.profileId
        })
        return { ok: true }
      }
      case 'update': {
        const ok = this.deps.store.updateFact(op.factId, { text: op.text, category: op.category })
        return ok ? { ok: true } : { ok: false, message: 'Unknown fact id' }
      }
      case 'remove': {
        const ok = this.deps.store.removeFact(op.factId)
        return ok ? { ok: true } : { ok: false, message: 'Unknown fact id' }
      }
    }
  }

  /* ── personal profiles (transformation) ─────────────────────────────── */

  listProfilesWithCounts(): Array<{
    profileId: string
    name: string
    factCount: number
    createdAt: string
    updatedAt: string
  }> {
    const profiles = this.deps.store.listProfiles?.() ?? []
    return profiles.map((p) => ({
      profileId: p.profileId,
      name: p.name,
      factCount: this.deps.store.countFacts?.(p.profileId) ?? 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }))
  }

  createProfile(name: string): { ok: boolean; profileId?: string; message?: string } {
    if (!this.deps.store.upsertProfile) return { ok: false, message: 'This store does not support profiles.' }
    if (name.trim().length === 0) return { ok: false, message: 'Profile name cannot be empty.' }
    const existing = this.deps.store.listProfiles?.() ?? []
    if (existing.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) {
      return { ok: false, message: 'A profile with this name already exists.' }
    }
    const profileId = `prof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    this.deps.store.upsertProfile({ profileId, name: name.trim(), createdAt: now, updatedAt: now })
    return { ok: true, profileId }
  }

  renameProfile(profileId: string, name: string): { ok: boolean; message?: string } {
    if (name.trim().length === 0) return { ok: false, message: 'Profile name cannot be empty.' }
    const ok = this.deps.store.renameProfile?.(profileId, name.trim()) ?? false
    return ok ? { ok: true } : { ok: false, message: 'Unknown profile id' }
  }

  deleteProfile(profileId: string): { ok: boolean; message?: string } {
    const ok = this.deps.store.deleteProfile?.(profileId) ?? false
    return ok ? { ok: true } : { ok: false, message: 'Unknown profile id' }
  }

  /* ── exclusions & listing ───────────────────────────────────────────── */

  setExclusion(sourceId: string | undefined, type: string | undefined, excluded: boolean): void {
    this.deps.store.setExcluded(sourceId, type, excluded)
  }

  listSources(): { sources: ContextSourceInfo[]; session: { id: string | null; transcriptItems: number; screenItems: number } } {
    const sources: ContextSourceInfo[] = []
    for (const doc of this.deps.store.listDocuments()) {
      sources.push({
        sourceId: doc.sourceId,
        type: 'document',
        displayName: doc.displayName,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        extractionStatus: doc.status,
        extractedChars: doc.text.length,
        preview: doc.text.slice(0, 400),
        excluded: this.deps.store.isExcluded(doc.sourceId, 'document')
      })
    }
    for (const fact of this.deps.store.listFacts(this.profileId)) {
      sources.push({
        sourceId: fact.factId,
        type: 'profile',
        displayName: `Profile: ${fact.category}`,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
        extractionStatus: 'ready',
        extractedChars: fact.text.length,
        preview: fact.text,
        excluded: this.deps.store.isExcluded(fact.factId, 'profile'),
        origin: fact.origin,
        category: fact.category
      })
    }
    const engineItems = this.deps.engine.snapshot()
    const session = {
      id: this.currentSessionId,
      transcriptItems: engineItems.filter((i) => i.kind === 'transcript').length,
      screenItems: engineItems.filter((i) => i.kind === 'screen').length
    }
    return { sources, session }
  }

  /* ── retrieval ──────────────────────────────────────────────────────── */

  /**
   * Deterministic retrieval for one request. Candidates:
   *  - documents + profile facts (only if the category is enabled)
   *  - live session items (only if enabled AND tagged with the CURRENT session)
   */
  retrieve(question: string, options: ContextOptions): RetrievalResult {
    const settings = this.deps.settings()
    const candidates: RankableItem[] = []

    if (options.includeDocuments) {
      for (const doc of this.deps.store.listDocuments()) {
        if (this.deps.store.isExcluded(doc.sourceId, 'document')) continue
        candidates.push({
          itemId: doc.sourceId,
          sourceId: doc.sourceId,
          type: 'document',
          displayName: doc.displayName,
          text: doc.text,
          updatedAt: Date.parse(doc.updatedAt)
        })
      }
    }
    if (options.includeProfile) {
      for (const fact of this.deps.store.listFacts(this.profileId)) {
        if (this.deps.store.isExcluded(fact.factId, 'profile')) continue
        candidates.push({
          itemId: fact.factId,
          sourceId: fact.factId,
          type: 'profile',
          displayName: `Profile: ${fact.category}`,
          text: fact.text,
          updatedAt: Date.parse(fact.updatedAt)
        })
      }
    }
    if (options.includeSession && this.currentSessionId) {
      for (const item of this.deps.engine.itemsForSession(this.currentSessionId)) {
        candidates.push({
          itemId: item.id,
          sourceId: `${item.kind}-${item.sessionId}`,
          type: item.kind === 'transcript' ? 'transcript' : 'screen',
          displayName: item.kind === 'transcript' ? 'Live transcript' : 'Screen observation',
          text: item.text,
          updatedAt: item.timestamp,
          sessionId: item.sessionId
        })
      }
    }

    const ranked = rank(question, candidates, {
      minScore: settings.minScore,
      perItemCharBudget: settings.perSourceCharBudget,
      maxTotalChars: settings.totalTokenBudget * 4,
      maxItems: 12
    })

    const block = renderContextBlock(ranked)
    return { items: ranked, estimatedTokens: estimateTokens(block), block }
  }

  /** IPC preview entry point (validated upstream). */
  preview(req: { question: string; options: ContextOptions }): { items: RetrievedItem[]; estimatedTokens: number } {
    const { items, estimatedTokens } = this.retrieve(req.question, req.options)
    return {
      items: items.map(({ itemId, sourceId, type, displayName, text, score, reason, sessionId }) => ({
        itemId,
        sourceId,
        type,
        displayName,
        text,
        score,
        reason,
        sessionId
      })),
      estimatedTokens
    }
  }

  /** Validate + preview from raw IPC payloads. */
  previewFromRaw(raw: unknown): { items: RetrievedItem[]; estimatedTokens: number } | { error: string } {
    const parsed = ContextPreviewRequestSchema.safeParse(raw)
    if (!parsed.success) return { error: 'Invalid preview request' }
    return this.preview(parsed.data)
  }
}
