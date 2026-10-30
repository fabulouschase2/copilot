/**
 * Legacy JSON → SQLite migration (Stage 9).
 *
 * Contract:
 *  - The original JSON file is backed up BEFORE anything else.
 *  - Import runs in one transaction; a failure rolls back and reports,
 *    leaving both the backup and the original untouched.
 *  - Success is verified by row counts before the legacy file is renamed to
 *    `<original>.migrated-<timestamp>` (never deleted).
 *  - Re-running is idempotent: an already-migrated store is detected and the
 *    import is skipped (INSERT OR REPLACE additionally prevents duplicates).
 *  - Malformed JSON is quarantined (renamed `.quarantine-<ts>`), never
 *    silently discarded; individual invalid records are skipped and counted
 *    in the report.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SQLiteStore, DocumentRecord, ProfileFactRecord } from './sqlite-store'

export interface MigrationResult {
  status: 'migrated' | 'already-migrated' | 'no-legacy' | 'quarantined' | 'failed'
  imported: { documents: number; facts: number; exclusions: number }
  skipped: number
  message?: string
  backupPath?: string
  quarantinedPath?: string
}

export function migrateLegacyJson(sqlite: SQLiteStore, legacyPath: string): MigrationResult {
  const empty = { documents: 0, facts: 0, exclusions: 0 }

  if (!fs.existsSync(legacyPath)) {
    // Already migrated previously? Detect the renamed artifact.
    const dir = path.dirname(legacyPath)
    const base = path.basename(legacyPath)
    const siblings = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    if (siblings.some((f) => f.startsWith(`${base}.migrated-`))) {
      return { status: 'already-migrated', imported: empty, skipped: 0 }
    }
    return { status: 'no-legacy', imported: empty, skipped: 0 }
  }

  // Parse and validate BEFORE any destructive step.
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))
  } catch {
    return quarantine(legacyPath, 'File is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return quarantine(legacyPath, 'File does not contain an object')
  }
  const data = parsed as { documents?: unknown; profileFacts?: unknown; excludedSourceIds?: unknown; excludedTypes?: unknown }

  // Backup before any rename/write.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${legacyPath}.backup-${stamp}`
  try {
    fs.copyFileSync(legacyPath, backupPath)
  } catch (err) {
    return {
      status: 'failed',
      imported: empty,
      skipped: 0,
      message: `Could not create backup: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Validate records; invalid ones are skipped AND counted (reported, and the
  // full original remains in the backup).
  const documents: DocumentRecord[] = []
  const facts: ProfileFactRecord[] = []
  let skipped = 0
  for (const raw of Array.isArray(data.documents) ? data.documents : []) {
    const d = raw as Partial<DocumentRecord>
    if (
      typeof d?.sourceId === 'string' && d.sourceId.length > 0 &&
      typeof d?.displayName === 'string' &&
      typeof d?.text === 'string' &&
      (d.status === 'ready' || d.status === 'partial') &&
      typeof d?.createdAt === 'string' && typeof d?.updatedAt === 'string'
    ) {
      documents.push(d as DocumentRecord)
    } else skipped += 1
  }
  for (const raw of Array.isArray(data.profileFacts) ? data.profileFacts : []) {
    const f = raw as Partial<ProfileFactRecord>
    if (
      typeof f?.factId === 'string' && f.factId.length > 0 &&
      typeof f?.text === 'string' &&
      typeof f?.category === 'string' &&
      ['background', 'skill', 'preference', 'project', 'other'].includes(f.category) &&
      f.origin === 'user' &&
      typeof f?.createdAt === 'string' && typeof f?.updatedAt === 'string'
    ) {
      // Legacy facts predate profiles; they belong to the default profile.
      facts.push({ ...(f as ProfileFactRecord), profileId: f.profileId ?? 'default' })
    } else skipped += 1
  }
  const excludedSources = Array.isArray(data.excludedSourceIds)
    ? data.excludedSourceIds.filter((v): v is string => typeof v === 'string')
    : []
  const excludedTypes = Array.isArray(data.excludedTypes)
    ? data.excludedTypes.filter((v): v is string => typeof v === 'string')
    : []

  // Transactional import with count verification.
  try {
    sqlite.transaction(() => {
      for (const d of documents) sqlite.addDocument(d)
      for (const f of facts) sqlite.addFact(f)
      for (const id of excludedSources) sqlite.setExcluded(id, undefined, true)
      for (const t of excludedTypes) sqlite.setExcluded(undefined, t, true)
      const counts = sqlite.counts()
      if (counts.documents !== documents.length || counts.facts !== facts.length) {
        throw new Error(
          `Post-import verification failed (documents ${counts.documents}/${documents.length}, facts ${counts.facts}/${facts.length})`
        )
      }
    })
  } catch (err) {
    return {
      status: 'failed',
      imported: empty,
      skipped,
      message: `Import rolled back: ${err instanceof Error ? err.message : String(err)}`,
      backupPath
    }
  }

  // Success: preserve the original under a .migrated- name (never delete).
  const migratedPath = `${legacyPath}.migrated-${stamp}`
  try {
    fs.renameSync(legacyPath, migratedPath)
  } catch {
    // Rename failure does not invalidate the verified import; report it.
    return {
      status: 'migrated',
      imported: { documents: documents.length, facts: facts.length, exclusions: excludedSources.length + excludedTypes.length },
      skipped,
      backupPath,
      message: 'Imported and verified, but the legacy file could not be renamed (it may be re-imported harmlessly; PKs prevent duplicates).'
    }
  }

  return {
    status: 'migrated',
    imported: {
      documents: documents.length,
      facts: facts.length,
      exclusions: excludedSources.length + excludedTypes.length
    },
    skipped,
    backupPath
  }
}

function quarantine(legacyPath: string, reason: string): MigrationResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinedPath = `${legacyPath}.quarantine-${stamp}`
  try {
    fs.renameSync(legacyPath, quarantinedPath)
  } catch (err) {
    return {
      status: 'failed',
      imported: { documents: 0, facts: 0, exclusions: 0 },
      skipped: 0,
      message: `Malformed legacy file and it could not be quarantined: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return {
    status: 'quarantined',
    imported: { documents: 0, facts: 0, exclusions: 0 },
    skipped: 0,
    message: `${reason}. File preserved at ${quarantinedPath}.`,
    quarantinedPath
  }
}
