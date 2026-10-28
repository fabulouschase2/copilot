# Stage Report — Stage 9: SQLite Persistence & Safe Data Migration (2026-10-25)

## Baseline (recorded before changes)

`vitest` 179/179 in 27 files · `tsc` node+web clean · `electron-vite build` success. (This stage also began with the real-provider verification run documented separately in `docs/real-provider-verification.md`.)

## Dependency decision (the packaging gate first)

**`node:sqlite` (Node built-in, experimental) — zero new npm dependencies.** Gate check run inside Electron 38 before committing: `DatabaseSync` + prepared statements work under Electron's Node 22.22.0. Consequences: no `better-sqlite3` native rebuild, no Electron ABI mismatch, no asar-unpack configuration, no packaging risk at all. Trade-off (documented): the API is flagged experimental by Node; a future Electron upgrade must re-run the gate (the store is behind a repository interface, so a swap is local).

## Files created or changed

**New:** `src/main/services/context/sqlite-store.ts` (repository: schema v1, WAL + `synchronous=NORMAL`, FK pragma, CHECK constraints, prepared/parameterized statements only, `VACUUM INTO` backup, `integrity_check`, transaction helper), `src/main/services/context/migration.ts` (JSON→SQLite migration: validate → backup → transactional import → count verification → rename; idempotent; quarantine for malformed input)
**Changed:** `src/main/index.ts` (SQLite store + one-shot migration at startup; backup/restore closures with bounded retention — 5 backups; restore keeps a `.pre-restore` copy so the only valid DB is never overwritten), `src/main/ipc.ts` (+3 persistence channels), `src/preload/index.ts`, `src/shared/protocol.ts` (`ContextPersistenceStatus` + channels), `src/renderer/src/ContextPanel.tsx` (Data storage card: status, migration state, backup/restore buttons with real results — no success indicator before the write succeeds), `src/main/services/context/context-service.ts` (additive `replaceStore` for restore)
**Tests:** `tests/sqlite-store.test.ts` (9), `tests/migration.test.ts` (7), `tests/stage9-persistence.test.ts` (3 incl. equivalence + perf)

## Schema (v1)

`documents(source_id PK, display_name, text, status CHECK ready|partial, created_at, updated_at)` · `profile_facts(fact_id PK, text, category CHECK …, origin CHECK user|model, created_at, updated_at)` · `exclusions(kind CHECK source|type, key, UNIQUE(kind,key))` · `meta(key PK, value)` for the schema version. Journal WAL, `synchronous=NORMAL` (documented trade-off: crash-safe, a power cut may lose the last checkpoint but never corrupts). Indexes: PKs + the exclusions unique index cover current query patterns (list-all scans of ≤ hundreds of rows measured at ≤ 15 ms; no speculative indexes added).

## Migration contract (all tested)

Backup **before** any change → transactional import → post-import count verification → legacy renamed `.migrated-<ts>` (never deleted). Malformed JSON is **quarantined** (`.quarantine-<ts>`, preserved, reported); invalid records are skipped and counted, never silently dropped. Re-runs detect the migrated artifact (`already-migrated`), and PKs make even forced re-imports duplicate-free. Mid-import failure rolls back completely (verified: zero rows after rollback, original + backup intact). Recovery path: the `.backup-<ts>` copy is plain JSON/DB-restorable, and restore-from-backup is a UI action.

## Persistent vs session data (policy unchanged, now enforced by storage split)

**Persistent (SQLite):** documents, profile facts, exclusions, migration metadata. **Session-only (never persisted):** transcripts, screen observations, question feeds — wiped at `beginSession`, gone on app close. Screenshots and audio blobs are never stored. **Credentials: OS-encrypted store only, never in SQLite.** SQLite is not encrypted at rest — the DB file is plaintext under the user profile (documented limitation; BitLocker/user-profile ACLs are the OS-level mitigations).

## Test results (actual)

- `tsc --noEmit` node + web: **0 errors**
- `vitest run`: **198/198 passed, 30 files** = 179 Stage 0–8 regression (green, unmodified) + 19 new: store CRUD/constraints/restart-persistence/clear (9), migration valid/malformed/idempotent/rollback/skip-counting (7), **retrieval equivalence JSON vs SQLite** (identical sourceIds + scores + token estimates across 3 queries; exclusions + session isolation parity) and perf (3). Test-driven fixes: two real bugs found by tests — `already-migrated` detection had a broken path computation (fixed in `migration.ts`); Windows EPERM on temp cleanup required explicit handle closing (test-infra only).
- Production-equivalent launch: app starts, **`context.db` created and live in userData** (WAL mode), clean shutdown.

## Performance (this machine, synthetic corpus)

Open **8–11 ms** · 60-document transactional import **~1.1–1.3 ms** · retrieval over 60 docs **~11–15 ms avg** (unchanged from JSON store; ranking dominates, storage does not) · `VACUUM INTO` backup **8–12 ms**.

## Completion gate

Stage 0–8 regression ✅ (179/179 within the 198) · typechecks + build ✅ · production launch with SQLite loading ✅ · migration fixtures: valid, malformed (quarantine), interrupted (rollback), repeated (idempotent) ✅ · backup + restore tested ✅ · retrieval/exclusion behavior preserved (equivalence tests) ✅ · session isolation intact ✅ · results recorded here ✅.

## Known limitations

1. `node:sqlite` is experimental — gate re-run required on Electron upgrades (interface-isolated).
2. No encryption at rest (documented; not claimed otherwise).
3. Backups are bounded to 5, manual-only (no scheduled backups yet).
4. Live-user-data migration ran against this machine's real (empty) store — `no-legacy`; the populated-path is fixture-tested, not user-data-tested, by design.

**Stage 10 not started.**
