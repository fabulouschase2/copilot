# ARCHITECTURE

This file describes the architecture **after** the overlay/local-STT/translation/story phases.
`docs/architecture.md` remains the detailed reference for stages 1–10 (audio pipeline, screen
analysis, context retrieval, persistence, hardening); this document covers the whole system and
the services added later.

## Stack (verified, not assumed)

Electron 38.8.6 · React 19 · TypeScript 5 · electron-vite 4 · zod 4 · `node:sqlite` (built in) ·
vitest 3 · koffi (Windows FFI, prebuilt).

No architectural replacement was made: the existing main/preload/renderer split, typed IPC
contract, and SQLite repository layer were preserved and extended.

## Process model

```
┌─────────────────────────────── Electron ────────────────────────────────┐
│ Renderer (sandboxed, no Node, no secrets)                               │
│   index.html   → interview · stories · practice · meetings · translate   │
│                  overlay controls · chat · settings                     │
│   overlay.html → frameless always-on-top captions/answer surface         │
│        ▲ window.copilot (typed contextBridge, zod-validated in main)     │
│ Preload  (bundled deps; single narrow bridge)                            │
│        ▲ ipcMain handlers                                               │
│ Main process                                                             │
│   WindowManager · OverlayController · IPC router                         │
│   ChatController · ModesService (interview/meeting) · PracticeService    │
│   TranscriptService (VAD, sessions, STT dispatch)                        │
│   SttRegistry → SegmentStt | DeepgramStt | LocalWhisperStt               │
│   LocalWhisperManager (child process)                                    │
│   TranslationService · StoryBankService                                  │
│   ScreenService · ContextService · SQLiteStore (schema v4)               │
│   SettingsStore · CredentialStore (safeStorage)                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Added services

### OverlayController + display affinity (Phase 6)

- Owns a separate `BrowserWindow` (`overlay.html`), frameless, `alwaysOnTop('screen-saver')`,
  `skipTaskbar`, persisted bounds.
- Applies `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` through koffi to **that window
  only**, then reads `GetWindowDisplayAffinity` back and reports the OS value.
- `exclusionActive` is derived from the OS echo (`0x11`), never from the user's setting; failures
  carry the Win32 error code.
- Receives live captions and answers by mirroring the events the main window already gets
  (`transcript:segment`, `mode:result`, `translation:result`), so it needs no provider access.

### LocalWhisperManager + LocalWhisperStt (Phase 1)

- Detects `whisper-server.exe` + `ggml-*.bin`, spawns and supervises the process, waits for HTTP
  readiness, reports pid/phase/log tail, stops on quit.
- The adapter posts multipart audio to `/inference` because the server has no OpenAI route
  (measured 404). Declared batch-only.

### TranslationService (Phase 4)

- Consumes finalized segments from `translation`-purpose sessions.
- Serial queue capped at 4 (drops oldest, counts drops), per-line provider attribution, session
  reset aborts in flight.
- Independent of `ModesService`; shares only the provider registry.

### StoryBankService (Phase 2)

- CRUD over `career_stories` (schema v4), profile-scoped.
- Deterministic lexical ranking (title 3.0 / skill 2.5 / body 1.0, normalized) with a reason per hit.
- Fact-grounded drafts via the active provider; drafts are returned to the editor and never saved.
- `promptBlock(question)` is appended to interview prompts only (`ModesService.getStoryBlock`).

## Data flow: one interview answer

```
audio → VAD → STT (cloud or local whisper) → transcript:segment
                                        ├→ question detection (interview only)
                                        └→ overlay captions (mirror)
user clicks Answer
  → ContextService.retrieve (documents, profile facts, session)
  → StoryBankService.promptBlock (top 3 verified stories)
  → interviewSystemPrompt + context + stories
  → provider.chatStream → mode:delta / mode:result
  → sources + evidence warning in UI · answer mirrored to overlay
```

## Session isolation

`SessionPurpose = interview | meeting | practice | translation`. Transcripts, question detection,
story attachment and translation are gated by purpose, so audio from one workflow can never appear
in another. Session-scoped context is wiped on `beginSession`.

## Persistence (schema v4)

`documents · profile_facts · profiles · exclusions · meetings · practice_sessions · practice_turns
· career_stories`. WAL, `synchronous=NORMAL`, foreign keys on, prepared statements only. No
transcripts, audio, screenshots, or keys are persisted. Migrations are additive and idempotent;
`context.db.pre-restore-*` is kept before a restore.

## Trust boundaries

- Renderer holds no credentials and no Node; all inbound payloads are zod-validated in main.
- Keys are decrypted only in main, at request time, and never logged.
- Capture requires an explicit arm per session; screen analysis is one-shot and consent-gated.
- The overlay is the only window with capture exclusion, and the UI reports only OS-confirmed state.

## Deliberate non-features

- No answer autotyping into other applications.
- No stealth recording, no proctoring evasion.
- No simulated payments, subscriptions or cloud sync.
