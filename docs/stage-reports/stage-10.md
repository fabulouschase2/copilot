# Stage Report — Stage 10: Security Hardening, UI Simplification & Reliability (2026-10-27)

**Scope note:** this stage combined the Stage 10 hardening specification with the user's mid-stage directives — (1) fix the app so it actually displays on Windows (it didn't), (2) an interview-first UI inspired by Poisely's observable flow, and (3) PDF resume import. No Stage 11 features were started.

## Baseline (recorded before changes)

`vitest` 198/198 in 30 files · `tsc` node+web clean · build success.

## The headline finding: a production-only black-window crash

**The app rendered a black window in production-equivalent launches** — on the developer's physical display, not just in captures. Root cause chain, diagnosed via CDP inspection of the live renderer:

1. `externalizeDepsPlugin` left `require('zod')` in the **preload** bundle.
2. **Sandboxed preloads cannot require external modules** → preload failed with "module not found: zod" → `window.copilot` was never exposed.
3. React mounted briefly, then crashed in effects (`Cannot read properties of undefined (reading 'onChatChunk')`) and unmounted the entire tree → black screen.

Dev mode worked (different bundling), which is why every prior "build + smoke (process alive)" check missed it. **Fixes:** preload dependencies are now bundled (`externalizeDepsPlugin({ exclude: ['zod'] })`); the renderer was inspected via CDP until `#root` actually mounted. This is why Stage 10 requires production-equivalent verification, not just "process alive".

**Second Windows fix:** with the UI rendering in the buffer, the physical display still showed black on this hybrid-graphics laptop → `app.disableHardwareAcceleration()` (software presentation; negligible cost for this UI). Confirmed visible on the physical screen afterwards.

Both fixes are pinned by permanent regression tests (SF-1 reads the built preload bundle; SF-7 checks the source).

## GUI verification (real, computer-use driven, Windows)

Performed on the production build: launch → **UI fully renders** (screenshot-verified: topbar, 7 tabs in one row, interview-first landing) → tabs navigate (Chat, Live with recording status/consent/Start, Screen with consent flow, Interview with quick actions) → **real chat message sent to Gemini, streaming state shown, Stop appeared** → **interview coding question with Coding style sent through the real model** → Stop state and the **evidence-warning banner rendered** ("No supporting evidence… NOT your experience") → app close clean.

Known GUI-session caveat: the very first test conversation disappeared when React remounted — chat messages are in-memory by design (documented since Stage 4; not a regression).

## Stage 10 threat model (documented, evidence-linked)

| Threat | Defense (verified) |
|---|---|
| Compromised renderer | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (SF-5); single narrow bridge (SF-4); every IPC payload schema-validated (SF-8); CSP `default-src 'self'` (SF-2); popups denied, external links go to the OS browser (SF-6) |
| Malicious imported files | Type/size bounds (PDF ≤ 10 MB, text ≤ 2 MB), binary sniffing, extraction capped, content fenced as untrusted data in prompts |
| Untrusted model output | Never auto-typed, auto-spoken, or submitted; displayed in-app only; source attribution + evidence warnings |
| API key leakage | Keys OS-encrypted (DPAPI/safeStorage), decrypted per-request in main only; SF-3 asserts no key shapes in built bundles; provider errors never echo keys (tested) |
| Provider failures | Timeouts + `AbortSignal.any` on every call, cancellation tested, HTTP status mapping, model flakiness documented (real-provider report) |
| DB corruption / termination | WAL + synchronous=NORMAL, `integrity_check`, `VACUUM INTO` backups (retention 5), restore never overwrites the only DB, legacy migration is backup→transaction→verify→rename |
| Local-service exposure | localhost endpoints intentionally supported (Ollama/LM Studio) — same trust domain; provider URLs are user-configured BYO-key by design (documented policy) |

**Dependency audit:** `npm audit --omit=dev` → **0 vulnerabilities** (production). Full audit → 5 dev-only (1 moderate, 2 high, 2 critical) all in the vitest toolchain; fix requires vitest 3→5 (breaking). **Accepted dev-only risk, documented** — none of it ships in the app.

## UI simplification (Part B) — what changed

- **Interview-first:** Interview is the landing tab with the Poisely-style flow — question box → style pills (STAR/Coding/Concise/Detailed/Technical) → Answer → streaming answer with source chips and evidence warnings. Quick actions: **📄 Resume** (PDF import) and **🖥️ Read screen** (visible, consent-armed screen read).
- Removed long explanatory texts (Chat/Live/Interview empty states now one line); tab row fits on one line with hidden overflow; consistent pill/chip control styles.
- All Stage 0–9 capabilities remain: Meeting, Live, Screen, Files (context), Chat, Settings.
- **No capture evasion** — Poisely's stealth behavior is explicitly excluded; the Read-screen action arms a visible consent window, and the UI states "nothing is sent elsewhere".

**Part C:** window position/size now persist across restarts (`window-bounds.json`, bounds-validated); pin (always-on-top), minimize/restore/close standard; recording status visible per panel.

## PDF resume import (user requirement)

`pdf-parse` (pure JS — keeps the zero-native-module property) extracts PDF text behind the same validation/bounds pipeline; scanned/image PDFs and password-protected files fail with clear messages. Verified against a **real Chrome-generated PDF fixture** (`tests/fixtures/test-resume.pdf`) and wired into both the Files tab and the Interview 📄 Resume action.

## Test results (actual)

- `tsc --noEmit` node + web: **0 errors**
- `vitest run`: **211/211 passed, 32 files** = 198 Stage 0–9 regression + 13 new (5 PDF, 8 security invariants SF-1…SF-8)
- `electron-vite build`: success · production-equivalent launch verified visually (CUA screenshots: before-black vs after-rendered)

## Performance (this machine, as previously measured — no new bottlenecks introduced)

Startup ~2–4 s to window · VAD 3,400× realtime (0.03 % core) · context retrieval ~12–15 ms/60 docs · SQLite open 8–11 ms, import 1.2 ms, backup 10 ms · real Gemini TTFT 0.6–68 s (model/tier dependent), streaming + cancellation verified.

## Remaining limitations / unverified

1. **Transcription (STT) verification still pending** — no Groq/other STT credential provided; Live transcription is unit-tested but never exercised end-to-end with a real speech provider.
2. **In-GUI real vision pass pending** — the real vision inference was verified through the harness (real screenshot → Gemini); the Screen-tab button flow in the GUI was clicked but the reply window wasn't captured before session end (harness evidence stands).
3. Dev-only audit findings (vitest toolchain) accepted, not fixed.
4. No formal security audit/certification — this stage's checks are targeted invariants, not an audit.
5. Interview/meeting answer **quality** remains model-dependent; the empty-completion flake on some free-tier models is documented with mitigation (no token caps) but can still occur.

## Completion gate

Regression suite ✅ (211/211) · both typechecks ✅ · production build ✅ · production-equivalent Windows launch with **visibly rendering UI** ✅ · security-sensitive changes have regression tests (SF-1…SF-8) ✅ · audit + threat model + real-provider reliability documented ✅. **No further stages started.**


## Addendum — UI rebuild to the Poisely-style workflow (same stage, same day)

The user rejected the previous interface as unchanged; the renderer was rebuilt to the reference workflow rather than restyled. **Files changed:** `App.tsx` (new shell: status header + one-row nav), `InterviewPanel.tsx` (full rewrite: session lifecycle, editable Interviewer box, refine actions, auto-answer countdown, transcript strip), `SetupPanel.tsx` + `SetupProvidersInline.tsx` (new merged Setup), `SetupProvidersInline.tsx`, `answerRender.tsx` (code-fence rendering), `src/shared/shortcuts.ts` (new registry), `src/main/index.ts` (registry-driven global shortcuts), `theme.css` (compact shell styles). **Removed:** ScreenPanel/TranscriptPanel/ContextPanel/SettingsPage (capabilities folded into Interview header, Setup, and the transcript strip — none lost).

**Visible differences (before → after, screenshot-verified via computer-use):** 7-tab dashboard → status header (Idle/Listening pill, Read screen, ⚙ Setup, pin, theme) + one-row nav (Interview/Meetings/Chat/Setup) → interview workspace with INTERVIEWER (editable question, Answer now, Clear) and YOUR ANSWER (streaming, Copy/Shorter/Rephrase/Regenerate) sections, style pills, Start/End interview session strip. Retired panels' functions remain reachable (documents/profile/backup → Setup; screen read → header; transcript → Interview drawer).

**New backend (reusing existing services):** `interviewRefine` (Shorter/Rephrase via refine prompts, same provider/slot machinery), job-description persistence (ranked document), interview settings block (delay 1–9 s default 3, auto-answer, company/role/source) persisted in settings.json, centralized shortcut registry (`shared/shortcuts.ts`) driving global shortcuts (Ctrl+Alt+C/R/E) and in-app chords (Ctrl+Enter answer, Ctrl+Shift+↓ shorter, Ctrl+Shift+↑ rephrase, Ctrl+Shift+C copy, Ctrl+Shift+Backspace clear, Escape stop).

**GUI-verified end-to-end (real Gemini):** typed question → Answer now → streamed STAR answer with ⚠ evidence banner → **Shorter** → live rewrite ("Your context lacks specific personal details…") → Setup: Company "Acme Robotics" typed → **persisted across full app restart** (verified in settings.json AND in the rebuilt Setup UI after relaunch).

**Test results:** 211/211 (32 files), tsc node+web clean, build success, production launch verified visually. **Unverified/pending:** live transcription E2E still needs an STT credential; meeting history persistence not built (meetings remain session+export); delay combobox via AXSetValue doesn't fire React change events (real mouse interaction works — automation limitation, not app bug); no formal security audit.
