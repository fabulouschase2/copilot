/**
 * Durable storage for user-approved context sources (Module H).
 * Documents the user explicitly imported and profile facts the user
 * explicitly wrote. Validated on load; corrupt files fall back to empty.
 * Everything here is local-only and removable via the UI.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ProfileCategory } from '../../../shared/protocol'

export interface DocumentRecord {
  sourceId: string
  displayName: string
  text: string
  status: 'ready' | 'partial'
  createdAt: string
  updatedAt: string
}

export interface ProfileFactRecord {
  factId: string
  text: string
  category: ProfileCategory
  /** Only ever 'user' unless a future explicit flow says otherwise. */
  origin: 'user' | 'model'
  createdAt: string
  updatedAt: string
  /** Owning personal profile (legacy JSON facts predate profiles). */
  profileId: string
}

interface StoreFile {
  version: 1
  documents: DocumentRecord[]
  profileFacts: ProfileFactRecord[]
  excludedSourceIds: string[]
  excludedTypes: string[]
}

const EMPTY: StoreFile = {
  version: 1,
  documents: [],
  profileFacts: [],
  excludedSourceIds: [],
  excludedTypes: []
}

export class ContextStore {
  private data: StoreFile

  constructor(private filePath: string) {
    this.data = this.load()
  }

  static forUserData(userDataDir: string): ContextStore {
    return new ContextStore(path.join(userDataDir, 'context-store.json'))
  }

  private load(): StoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile
      if (raw && raw.version === 1 && Array.isArray(raw.documents) && Array.isArray(raw.profileFacts)) {
        return {
          version: 1,
          documents: raw.documents,
          profileFacts: raw.profileFacts,
          excludedSourceIds: raw.excludedSourceIds ?? [],
          excludedTypes: raw.excludedTypes ?? []
        }
      }
    } catch {
      /* missing or corrupt: start empty */
    }
    return { ...EMPTY }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8')
  }

  /* documents */

  listDocuments(): DocumentRecord[] {
    return [...this.data.documents]
  }

  getDocument(sourceId: string): DocumentRecord | undefined {
    return this.data.documents.find((d) => d.sourceId === sourceId)
  }

  addDocument(doc: DocumentRecord): void {
    this.data.documents = this.data.documents.filter((d) => d.sourceId !== doc.sourceId)
    this.data.documents.push(doc)
    this.persist()
  }

  removeDocument(sourceId: string): void {
    this.data.documents = this.data.documents.filter((d) => d.sourceId !== sourceId)
    this.data.excludedSourceIds = this.data.excludedSourceIds.filter((id) => id !== sourceId)
    this.persist()
  }

  /* profile */

  listFacts(profileId?: string): ProfileFactRecord[] {
    const all = [...this.data.profileFacts]
    // Legacy records without a profile id belong to the default profile.
    return profileId ? all.filter((f) => (f.profileId ?? 'default') === profileId) : all
  }

  addFact(fact: ProfileFactRecord): void {
    this.data.profileFacts.push(fact)
    this.persist()
  }

  updateFact(factId: string, patch: { text?: string; category?: ProfileCategory }): boolean {
    const fact = this.data.profileFacts.find((f) => f.factId === factId)
    if (!fact) return false
    if (patch.text !== undefined) fact.text = patch.text
    if (patch.category !== undefined) fact.category = patch.category
    fact.updatedAt = new Date().toISOString()
    this.persist()
    return true
  }

  removeFact(factId: string): boolean {
    const before = this.data.profileFacts.length
    this.data.profileFacts = this.data.profileFacts.filter((f) => f.factId !== factId)
    const changed = this.data.profileFacts.length !== before
    if (changed) this.persist()
    return changed
  }

  /* exclusions */

  isExcluded(sourceId: string, type: string): boolean {
    return this.data.excludedSourceIds.includes(sourceId) || this.data.excludedTypes.includes(type)
  }

  setExcluded(sourceId: string | undefined, type: string | undefined, excluded: boolean): void {
    if (sourceId) {
      this.data.excludedSourceIds = this.data.excludedSourceIds.filter((id) => id !== sourceId)
      if (excluded) this.data.excludedSourceIds.push(sourceId)
    }
    if (type) {
      this.data.excludedTypes = this.data.excludedTypes.filter((t) => t !== type)
      if (excluded) this.data.excludedTypes.push(type)
    }
    this.persist()
  }

  clearAll(): void {
    this.data = { ...EMPTY }
    this.persist()
  }
}
