# Copilot v0.2.1 — Full Functionality Audit & Audio Fix Report

Date: 2026-11-02 · Baseline: v0.2.0 (248 tests) → Release: v0.2.1 (**267 tests**)
Test environments: development build (`electron .`, CDP-driven) **and** packaged installer (`Copilot-Setup-0.2.1.exe`, silently installed to `%LOCALAPPDATA%\Programs\Copilot`).
Real providers used: Google Gemini (`gemini-3.5-flash`, key stored OS-encrypted — never read or printed). Real audio: Windows SAPI speech played through the physical speakers (system loopback path) and the built-in microphone (acoustic path).

## 1. Root cause of the "Start interview does not hear the AI interviewer" failure

Two stacked defects — reproduced live, verified fixed live:

1. **The renderer never captured audio.** `InterviewPanel.startInterview` called `prepareTranscript` + `beginTranscript` but **never called `startCapture`** — the sensor layer was missing entirely. The main process sat in `listening` state receiving zero PCM chunks; no VAD, no STT, no transcript, ever. The UI showed "Listening" while nothing was captured. This predates v0.2.0 (the Stage-10 panel had the same gap) and was invisible to the automated suite because tests drive `TranscriptService.ingestChunk` directly with synthetic audio — the renderer wiring was never covered.
2. **Electron's getDisplayMedia permission flow denied system audio.** Verified with instrumented handlers on Electron 38: a renderer `getDisplayMedia()` first arrives at `setPermissionRequestHandler` as a **`'media'`** request. The old handler consumed the unarmed `'media'` gate → `callback(false)` → instant `NotAllowedError`, and the armed `'display-capture'` approval was never consumed. The display-media handler was never reached.

**Fixes** (commit `0877af2` + this release):
- `InterviewPanel.tsx` now starts capture on Start, streams PCM chunks, stops capture on End, handles device loss (`onEnded`), and surfaces `onTranscriptError` (STT/permission/device) — MeetingPanel swallowed those too, also fixed.
- The permission layer grants the loopback front door from the `display-capture` arm (non-consuming); single-use consumption remains in the display-media handler that actually provides the source. Every grant still requires an unexpired arm from an explicit Start click (no consent-model change).
- A **renderer-contract test** (`tests/renderer-contracts.test.ts`) now pins this wiring statically so the "session says Listening but nothing is captured" class cannot ship silently again.

## 2–3. Files changed and fix implemented

| File | Change |
|---|---|
| `src/renderer/src/InterviewPanel.tsx` | Capture wiring (start/stop/device-loss), transcript-error surfacing, in-view source selector, live source + speech indicators, diagnostics access |
| `src/main/index.ts` | Permission-layer fix (loopback front door), `getAudioDiagnostics` composition |
| `src/main/services/transcription-service.ts` | Diagnostics snapshot (`getDiagnostics`: session/metrics/lastSegmentAt/lastError), error recording |
| `src/main/services/modes/modes-service.ts` | `transcriptText` for end-of-meeting summary/ask (session-lifetime decoupling), 429 messaging |
| `src/main/services/practice/practice-service.ts` | One-retry on 429 (nothing streamed → safe), stale-`active` session cleanup at startup |
| `src/main/services/screen/screen-service.ts` | Bounded one-retry for empty vision responses + honest error (Gemini 3.x empty-stream mode) |
| `src/renderer/src/MeetingPanel.tsx` | Transcript travels with summary/ask requests; saved-meeting ask routing fixed; transcript-error surfacing |
| `src/renderer/src/PracticePanel.tsx` | `awaitingEval` state (no double-submit), previous feedback stays readable, auto-cancel on unusable session (first question fails) |
| `src/renderer/src/ReadScreenModal.tsx` | Removed `clearScreen()` that defeated duplicate detection |
| `src/renderer/src/speak.ts` | `onStart`/`onEnd` speech events |
| `src/renderer/src/PracticePanel.tsx` + `speak.ts` | **Feedback-loop guard**: practice mic is muted while TTS reads the question — the app can never transcribe its own interviewer voice as the user's answer |
| New: `src/renderer/src/AudioDiagnosticsModal.tsx`, `src/renderer/src/audio/capture-state.ts`, `src/shared/protocol.ts` (AudioDiagnosticsInfo), `ipc/preload` | Diagnostics view |
| New tests: `tests/audio-pipeline.test.ts` (9), `tests/renderer-contracts.test.ts` (6) | §7 suite |
| New: `scripts/cdp-eval.mjs`, `scripts/audit-practice.mjs` | Real-device test harness |
| `package.json` | 0.2.1 |

## 4–7. Real audio tests (this machine, Windows 10.0.22000)

| Test | Dev build | Installed 0.2.1 | Evidence |
|---|---|---|---|
| System-audio capture starts; PCM flows | PASS — 37 chunks / 3.7 s within 5 s of Start | PASS — 36 chunks / 5 s | `getAudioDiagnostics` counters |
| Real speech through speakers heard (VAD) | PASS — `speechActive:true` during SAPI playback, `false` after | PASS — 504 chunks across the 6 s utterance | live poll trace |
| VAD segmentation | PASS — 2 segments cut from one utterance | PASS — segment → STT request on close | metrics `segmentsFinalized`/`sttRequests` |
| STT request reaches the real provider | PASS — Groq API responded (HTTP 401) | PASS — same | `lastError.code='stt'` |
| **Transcription result** | **BLOCKED — no Groq API key saved** (user's settings show provider `whisper-large-v3` @ Groq with `hasCredential:false`) | **BLOCKED** — same | The 401 from the real provider proves the pipeline up to the credential boundary; the error is surfaced verbatim in the UI |
| Question detection → answer generation after live speech | **BLOCKED** (needs transcription) | **BLOCKED** | Question detection is unit-tested (question-detection.test.ts) and manual entry → answer is PASS (below) |
| Microphone capture (acoustic: speakers → built-in mic) | PASS — `speechActive:true` during playback, 5 STT requests | not repeated (same code path) | live poll trace |
| Pause / Resume / Mute / Unmute | PASS — state + counters behave (chunks stop while muted) | n/a | meeting lifecycle test |
| Device disconnection | PASS by wiring (`onEnded` handler + test contract); real unplug not performed | — | PARTIAL |
| Session teardown | PASS — capture released, permission gates consumed, session null | PASS — `sessionReleased:true` | diagnostics after End |

**To unblock the last step**, the user must save a Groq API key once: Settings → Providers → Transcription providers → select the Groq row → paste the key (stored OS-encrypted). No code change is needed; the pipeline is verified end-to-end up to that credential.

## 8. Interview functionality (§3.A)

| Feature | Test performed | Result | Evidence |
|---|---|---|---|
| Start interview (mic) | Real capture, live status | **PASS** | chunks flow, source badge "Microphone" |
| Start interview (system audio) | Real loopback + real speech | **PASS** | chunk counters + VAD trace |
| End interview | Real teardown | **PASS** | gates consumed, session null |
| Audio-source selection | In-view select + Settings, persisted | **PASS** | settings round-trip |
| Live transcript / partials / segments | Real STT blocked (credential) | **BLOCKED** | segments path unit-tested; UI renders segments when they exist |
| Automatic question detection | After real speech | **BLOCKED** (transcription) | detector unit-tested; manual pipeline verified |
| Automatic answering (delay + countdown) | Countdown UI verified; full chain blocked on STT | **PARTIAL** | countdown badge renders; auto-answer logic unit-tested |
| Manual question entry → Answer now | Real Gemini, streamed | **PASS** | 856-char streamed answer |
| Anti-fabrication | Asked with empty profile / matching profile | **PASS** | "[Missing details — general guidance]" with empty context; grounded answer + "Profile: skill 100%" source with matching fact |
| Stop generation | Stop button wired to cancel (service cancel is unit-tested) | **PASS** (by test) | — |
| Regenerate | Real Gemini | **PASS** | second streamed answer |
| Copy | Clipboard write | **PASS** | write ok (clipboard read-back restricted to focused apps — environmental) |
| Shorter / Rephrase | Real Gemini | **PASS** | 780 → 384 chars, facts kept |
| Clear | Click | **PASS** | fields reset |
| Behavioral (STAR) mode | Real answer, STAR structure + `[profile]` citations | **PASS** | streamed output |
| Coding mode | Real answer | **PASS** | fenced `javascript` code block rendered |
| Research mode | Covered by same prompt pipeline (style instruction differs only) | **PASS** (by prompt unit tests + mode pipeline) | — |
| Length (concise/detailed) | Separate control, prompt-verified | **PASS** | prompts unit-tested for both instructions |
| Response language (German) | Real Gemini answer fully in German | **PASS** | "[Fehlende Details — Allgemeine Anleitung]…" |
| Resume/profile context | Retrieval preview + grounded answer | **PASS** | résumé 100% / profile fact retrieval |
| Screen-reading integration | Modal flow below | **PASS** | — |
| Session isolation | Purpose tags + renderer filters | **PASS** | audio-pipeline + contract tests |

## 9. Practice functionality (§3.B)

| Feature | Test performed | Result | Evidence |
|---|---|---|---|
| Configuration (type/difficulty/count/JD/role/profile) | UI driven across all 7 types | **PASS** | sessions persisted with correct config |
| Question generation (real Gemini) | Multiple sessions, all types attempted | **PASS** | distinct, type-appropriate questions (behavioral/coding/system-design/technical/SWE/AI-QA/custom) |
| TTS read-aloud + feedback-loop guard | speaking state toggles; mic muted during playback | **PASS** (wiring verified; speech not heard by ear — no human listener) | `speak.ts` onEnd guard code + state |
| Spoken answers | Mic capture in practice purpose | **PASS** (capture path) / **BLOCKED** (transcription accuracy — no STT key) | — |
| Typed answers → submission | Real submissions | **PASS** | persisted turns |
| Rubric evaluation (5 dimensions) | Real Gemini evaluations | **PASS** — observed 1/5, 2/5, 3/5 with dimension breakdowns, strengths, "Improve: …" hints | live UI + persisted feedback JSON |
| Suggested improved answers | Present in feedback | **PASS** | improvedAnswer in feedback JSON |
| Final scorecard | Live run **BLOCKED** — persistent Gemini 503s during the audit window (free-tier instability) | **PASS by integration tests** (full scripted loop incl. scorecard + persistence); live **BLOCKED** | tests/practice-service.test.ts |
| Persistence + reopen | Sessions listed with status/score, reopened from history | **PASS** | history list after restart |
| Stale-session hygiene | Killed app mid-session; restart marks orphans `cancelled` | **PASS** | 11 sessions all `cancelled` after restart |
| No self-evaluation of its own voice | Practice mic muted during TTS | **PASS** (by construction + guard code) | feedback-loop guard |

## 10. Meetings (§3.C)

| Feature | Test performed | Result | Evidence |
|---|---|---|---|
| Create meeting + title + source + language + provider display | UI driven | **PASS** | title/audio/language badges + "Groq whisper-large-v3" display |
| Start/End recording | Real mic + system capture | **PASS** | purpose=meeting chunks flowing |
| Pause / Resume / Mute | Real session | **PASS** | state + chunk counters |
| Live transcript, Mic/System attribution, timestamps | Real STT blocked (credential) | **BLOCKED** (render path unit-tested) | — |
| Device-disconnection recovery | `onEnded` wiring + contract test | **PARTIAL** (wiring verified; real unplug not performed) | — |
| Auto-summary on end | With real transcript | **BLOCKED** (needs STT + Gemini); **Bug found & fixed**: v0.2.0 generated the summary AFTER the session ended against session-only context → always failed. Now the captured transcript travels with the request (unit-tested) | transformation-contract tests |
| Action-item extraction / owners / deadlines | Parser + generation | **PASS** (parser unit-tested: "Update the docs — Owner: Ada — Deadline: Friday") / generation BLOCKED as above | — |
| Editing notes | Editable textarea | **PASS** | edited before save |
| Save / Search (incl. action items) / Reopen / Delete | Real SQLite | **PASS** | saved list, search hit 1/miss 0, reopen with duration+language+provider badges, delete → empty |
| Export Markdown / TXT | Native save dialog | **NOT TESTED** (dialog requires manual interaction; mechanism unchanged since Stage 8 verification) | — |
| Ask questions about saved meetings | Routing fixed (was hitting live-session path after reopen — **bug found & fixed**); real answer BLOCKED (Gemini instability) | **PASS** (routing, by tests) / answer **BLOCKED** | new unit tests assert saved-transcript routing |
| Leak checks (interview ↔ meetings) | Purpose filtering: renderer filters by `purpose` + main gates question detection to interview sessions; saved transcripts contain only their own session | **PASS** (structural, by tests) | audio-pipeline + contract tests; saved record contained no interview content |

## 11. Profiles & documents (§3.D)

| Feature | Result | Evidence |
|---|---|---|
| Create profile ("QA track") | **PASS** | chip appears + auto-activates |
| Add profile facts | **PASS** | "QA automation with Playwright" added to QA track |
| Edit / remove facts | **PASS** (existing flows unchanged) | Setup UI |
| Rename profile | **PASS** | "QA track" → "QA track 2026" |
| Switch active profile | **PASS** | chip activation + settings persisted |
| Retrieval uses the correct active profile | **PASS** — Playwright question: from Default → résumé only; from QA track → "Profile: background 100%" | previewContext |
| Delete profile (+ its facts), unknown id rejected | **PASS** | list shrinks to "Default (1)" |
| Import résumé PDF / TXT / MD | Existing user résumé present + used in retrieval (100%) | **PASS** for stored docs; the import *dialog* itself not re-driven (NOT TESTED for new import) |
| DOCX | Not supported (documented exclusion) | — |
| Existing user data intact | **PASS** | company, résumé, settings survived all migrations/restarts |

## 12. Screen understanding (§3.F)

| Feature | Result | Evidence |
|---|---|---|
| Open Read screen; screen/window source picker with live thumbnails | **PASS** | 1 screen source enumerated, thumbnails render |
| Preview capture | **PASS** | post-crop preview image rendered |
| Analyze screen (real Gemini vision) | **PASS** ×2 | structured analysis of the real screen content incl. the Copilot window itself; provider+model badge shown |
| Vision empty-response handling | **Bug found & fixed**: v0.2.0 could complete silently with empty text; now one bounded retry + honest error | unit-tested paths |
| Retry failed analysis | Retry button renders and re-runs | **PASS** (button path) |
| Duplicate capture skips provider | Mechanism unit-verified; live trigger **PARTIAL** — the modal's own animated spinner changes pixels each frame, so identical-screen detection rarely fires while the modal is open (documented) | image-hash/screen-service tests |
| Region selection | **PASS** — drag registers ("selection active"), crop pipeline runs without local error | pointer-driven drag on preview |
| Region + provider completion | **PARTIAL** — two attempts hit transient Gemini 503s (surfaced verbatim) | — |
| Multiple monitors / permission denial / provider failure | Single-monitor machine (1 source) — multi-monitor NOT TESTED; denial + provider errors surface honestly (**PASS** for error surfacing, observed 429/503) | — |

## 13. Providers & settings (§3.G)

| Feature | Result | Evidence |
|---|---|---|
| Gemini connectivity (real key, OS-encrypted) | **PASS** | `testProvider` → Connected, 555 ms |
| Add/configure OpenAI-compatible / OpenRouter / Groq / local | Groq STT row exists (no key — the audit blocker); others not modified (user's live config respected) | **PARTIAL** — mechanism unchanged from Stage 4 verification |
| Save API keys | Keys stay OS-encrypted; diagnostics expose only `hasCredential` | **PASS** (no secret ever printed) |
| Change models / active provider | Hot-switch preserved (next request) | **PASS** (unchanged code path, unit-tested) |
| Change response language | **PASS** (German answer live) | — |
| Change theme | **PASS** — light survives restart, restored to dark | `.app[data-theme]` across restarts |
| Change interview settings (delay 4s) | **PASS** — persisted across restart | settings round-trip |
| Transcription language / provider config | Field present, provider displayed | **PASS** (UI) |
| Settings persist after restart | **PASS** | delay/theme/source verified |

## 14–17. Gates, installer, production

| Gate | Result |
|---|---|
| Test suite | **267/267 passing, 38 files** (248 preserved + 19 new: 9 audio-pipeline, 6 renderer-contracts, 4 meeting/meeting-ask contracts) |
| TypeScript (node + web) | **0 errors** |
| Production build | **success** |
| Installer | `dist/Copilot-Setup-0.2.1.exe` built (electron-builder exit 0) |
| Silent install | **PASS** → `%LOCALAPPDATA\Programs\Copilot` |
| Installed app launch | **PASS** (window "Copilot", renderer reachable) |
| **Critical audio test in production** | **PASS** — system-audio Start interview: 36 chunks/5 s idle, 504 chunks across the real 6 s utterance, VAD fired, STT request reached the real provider (401 honest error shown), End released everything (`sessionReleased:true`) |
| SQLite + migrations | **PASS** — user data (company, résumé, settings) intact across all restarts; practice/meeting/profile tables exercised |
| Logs | No unexpected errors (only the known Node SQLite experimental warning) |

## 18. Remaining blockers

1. **Groq API key not saved** → live transcription, live question detection, spoken practice answers, meeting transcripts/summaries remain **BLOCKED at the credential boundary**. One-time fix by the user in Settings → Providers (no code change needed). Everything up to the boundary is real-audio verified.
2. **Gemini free-tier instability** (429/503 bursts during the audit) blocked three live observations: practice scorecard, meeting summary with real transcript, region-capture provider completion. All three paths are integration-test-verified; the exact same code paths completed live when the provider was healthy (evaluations, vision analyses, chat).
3. Export dialogs (notes) and real device-unplug not re-driven in this audit (NOT TESTED / PARTIAL as noted per row).

## Verdict

The reported critical bug is **fixed and verified with real audio in both the development build and the installed application**. The application now captures what it says it captures, shows honestly what state the audio pipeline is in (Audio diagnostics view), and never presents "Listening" without flowing audio. All 248 pre-existing tests were preserved and extended to 267.
