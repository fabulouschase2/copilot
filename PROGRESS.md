# PROGRESS

Live development log for the Klevi-level transformation. One section per completed
phase, with what was built, what was tested, and where the evidence lives.

Branch: `feature/klevi-level-transformation`

## Baseline (before any change)

Measured on the user's machine (Windows 11 Pro, build 22000, i5 11th gen, 8 GB RAM):

| Check | Result |
|---|---|
| `npm install` | OK (Electron binary requires `node node_modules/electron/install.js` under npm 11 script gating) |
| `npm test` | **282 / 282 passed**, 39 files |
| `npm run typecheck` | pass (main + renderer) |
| `npm run build` | pass (`out/main`, `out/preload`, `out/renderer`) |

The repository's own claims (282 tests, Electron 38, React 19, SQLite) were accurate
when checked against the code, so no architectural replacement was justified.

## Phase 0 — audit and protection

- Repository cloned and inspected: 129 tracked files, single `master` branch, clean tree.
- Existing stack verified: Electron 38.8.6, React 19, TypeScript 5, electron-vite,
  zod 4, `node:sqlite` persistence, OpenAI-compatible provider adapter.
- Working branch created from `master`; `master` untouched; no force-pushes.
- Baseline captured above; every later phase is compared against it.

## Phase 6 — private desktop overlay (delivered)

Scope note: the previous roadmap deliberately excluded a capture-invisible overlay.
This phase reverses that decision *only* for the overlay window, with the user's
explicit requirement, and keeps the honesty rules: the OS value is what gets shown.

Implemented:

- `src/main/services/overlay/display-affinity.ts` — `SetWindowDisplayAffinity` /
  `GetWindowDisplayAffinity` bound through koffi (prebuilt FFI, no compiler). Lazy,
  defensive loading; failures carry the Win32 code.
- `src/main/services/overlay/overlay-state.ts` — pure support assessment and state
  derivation (`exclusionActive` is true only when the OS echoes `0x11`).
- `src/main/overlay-window.ts` — frameless always-on-top window, persisted bounds,
  opacity/font-size, live caption + answer mirroring, per-window affinity, restore on
  startup, close-to-disable.
- `src/shared/protocol.ts` — overlay settings (`enabled`, `captureExcluded`, `opacity`,
  `fontSize`, `showCaptions`), IPC channels, bounded content schema.
- `src/renderer/overlay.html`, `src/renderer/src/overlay.tsx`, `overlay.css` — second
  renderer document (multi-page electron-vite build).
- `src/renderer/src/OverlayPanel.tsx` + nav item + header chip — toggles, OS-reported
  status, error codes, and an explicit "does / does not" list.
- Global shortcut `Ctrl+Alt+O`.
- `src/main/selftest.ts` — two verification harnesses (pixel-level capture test,
  real-window integration test).

Verified:

- Pixel test: magenta probe covered 8.21% of the captured frame when capturable and
  **0%** when excluded; OS affinity `0x11`. See `docs/overlay-capture-exclusion.md`.
- Window test: real `overlay.html` mounts, shows "excluded from capture", renders
  pushed content.
- `tests/overlay-phase6.test.ts`: 18 tests (support matrix, no-over-claim state
  derivation, Win32 error mapping, HWND parsing, schema bounds).
- Full suite after the phase: **300 / 300 passed**; typecheck and build clean.

Not verified (do not claim): OBS Studio and Google Meet capture behaviour — neither was
available on this machine.

## Phase 1 — managed local transcription (delivered)

Implemented:

- `src/main/services/stt/local-whisper.ts` — child-process manager (detect, spawn, readiness
  poll, crash reporting, bounded log tail, stop on quit) plus `LocalWhisperStt`, an adapter for
  the server's real `/inference` contract.
- `src/main/services/stt/stt-registry.ts` — builds the local adapter when a provider row uses
  `protocol: 'whisper-cpp'`; all existing providers keep the OpenAI path.
- Settings → Providers → **Local speech recognition (whisper.cpp)**: executable/model paths,
  port, threads, language, detect-install, start/stop, live status, log tail, and a single
  control that creates and activates the `local-whisper` transcription row.
- `whisper:*` IPC channels, validated with zod; the manager is disposed on `will-quit`.

Verified:

- `/v1/audio/transcriptions` returns **404** on whisper.cpp 1.9.6-dev and `/inference` returns
  `{text}` — measured before writing the adapter, so no OpenAI assumption was baked in.
- Managed server + real adapter + real `jfk.wav`: started in 337 ms, transcribed 11 s of audio
  in 533 ms on CPU, transcript matched the JFK line.
- Zero orphan `whisper-server` processes after app exit.
- `tests/whisper-phase1.test.ts`: 15 tests (detection ordering, missing exe/model, lifecycle,
  unexpected exit, `/inference` request shape, no-fake-partials, schema bounds).
- Full suite after the phase: **315 / 315 passed**; typecheck and build clean.

Evidence: `docs/local-whisper.md`.

## Phase 4 — live translation (delivered)

Implemented:

- `src/main/services/translation/translation-service.ts` — independent language engine: serial
  queue capped at 4 pending lines, provider named on every result, mechanical wrappers stripped,
  empty output treated as failure, session reset aborts in-flight work.
- New `translation` session purpose, so translation audio never mixes with interview, meeting or
  practice transcripts.
- `src/shared/languages.ts` — 49 selectable target languages.
- **Translate** panel: mic/system source, target language, show-original toggle, caption size,
  live rows with per-line provider attribution, and a “Test the engine” box that cannot disturb a
  live session.
- Translated lines mirror to the private overlay (Phase 6 integration).

Verified:

- Real model, no API key: Ollama `qwen2.5:1.5b` translated English → Spanish in 3.7 s, and the
  live pipeline (`observeSegment` → `translation:result`) produced exactly one correctly
  attributed event.
- `tests/translation-phase4.test.ts`: 15 tests (prompt contract, sanitising, missing provider,
  provider error, empty output, disabled mode, one-result-per-segment, backlog bound, session
  reset, schema bounds).
- Full suite after the phase: **330 / 330 passed**; typecheck and build clean.

Not verified: cloud providers (no key), non-English source audio, and a real microphone session
for translation. Evidence and caveats: `docs/live-translation.md`.

## Phase 2 — career story bank (delivered; docx + fact confirmation still open)

Implemented:

- SQLite **schema v4**: additive `career_stories` table, index, safe migration from
  v2/v3, no alteration of existing tables.
- `src/main/services/stories/story-service.ts` — CRUD, deterministic relevance ranking with
  reasons, prompt rendering, and fact-grounded draft generation via the active provider.
- **Stories** panel: list/search, create/edit/delete, framework picker (STAR/CAR/PAR/SOAR/
  answer-first) with per-framework field labels, skills, role, and a draft action.
- Interview integration: the top-ranked verified stories are appended to the interview prompt
  (`VERIFIED CAREER STORIES` block), never to meeting prompts.
- Profile scoping on read, write and delete; a story from another profile cannot be edited.

Verified:

- Real draft via Ollama `qwen2.5:1.5b`: grounded in the supplied facts, 17.9 s, saved, then
  retrieved by relevance with an explainable reason (`score 0.505`).
- `tests/stories-phase2.test.ts`: 23 tests (tokenizer, ranking weights and caps, CRUD rules,
  cross-profile refusal, prompt block, JSON extraction, draft failures, SQLite round-trip).
- Full suite after the phase: **353 / 353 passed**; typecheck and build clean.

Observed limitation: the 1.5B model embellished one outcome (“improved team productivity”)
beyond the facts. Drafts are therefore never auto-saved and the editor requires review.
Evidence: `docs/career-story-bank.md`.

Still open in this phase: DOCX résumé import and a per-fact confirmation workflow.

## Remaining phases

Tracked in `FEATURE_STATUS.md`. Cloud sync, billing and the phone companion require
external infrastructure and credentials that this machine does not have; they are
listed there as blocked rather than mocked up.
