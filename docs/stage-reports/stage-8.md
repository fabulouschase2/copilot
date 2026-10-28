# Stage Report — Stage 8: Interview & Meeting Modes (2026-10-24)

## Baseline (recorded before changes)

`vitest` 149/149 in 23 files · `tsc` node+web clean · `electron-vite build` success.

## Files created or changed

**New (main):**
- `src/main/services/modes/question-detection.ts` — pure, conservative question detector: trailing `?` (high confidence) or interrogative/interview openers (medium, with substance requirement), discourse-marker stripping ("Then tell me…"), negative-prefix and mid-sentence filters against false positives, behavioral/technical/general classification, deterministic dedupe
- `src/main/services/modes/prompts.ts` — pure prompt builders; the **fabrication prohibition** is a tested contract of every interview style; meeting prompts require evidence-only owners/deadlines ("(not stated)") and separate confirmed statements from interpretation (`[suggested]`, "Interpretation:")
- `src/main/services/modes/modes-service.ts` — orchestrator: one generation slot per channel (interview/meeting), streaming via the **existing** `AIProvider` interface + `ProviderRegistry`, retrieval via the **existing** `ContextService` (same budgets/exclusions/session boundaries), deterministic `assessEvidence` (none/partial/good), question feed (current session only, reset on session change), user-initiated notes export through an injected `saveText` hook
**Changed:** `src/shared/protocol.ts` (mode request/result/event contracts + `CopilotApi` additions), `src/main/ipc.ts` (6 mode channels; transcript segments now feed question detection; mode lifecycle wired to session start/stop), `src/main/index.ts` (ModesService + dialog-based `saveText`), `src/preload/index.ts`
**New (renderer):** `src/renderer/src/InterviewPanel.tsx`, `src/renderer/src/MeetingPanel.tsx`
**Changed (renderer):** `App.tsx` (two new tabs), `theme.css`
**Tests:** `tests/question-detection.test.ts`, `tests/prompts.test.ts`, `tests/modes-service.test.ts`, `tests/protocol-stage8.test.ts`

**Dependencies added: none.**

## Objective → status

### Interview mode
- Question detection from live transcript **and** manual input — implemented (detected feed events; per-sentence conservative heuristics; false-positive handling pinned by tests)
- Manual answer generation trigger only — implemented (button/Enter; nothing runs autonomously)
- Retrieval restricted to profile + documents + explicitly-enabled current session — implemented (reuses Stage 7 pipeline; `includeSession` defaults false in the schema)
- Concise / detailed / technical / STAR styles — implemented (tested prompt contracts; STAR requires labeled sections + `[General STAR template]` fallback)
- Answer + supporting sources + uncertainty warnings — implemented (`contextUsed` rendered as source list; `evidenceLevel` 'none'/'partial' produces a UI banner)
- No invented experience — enforced at the prompt-contract level (prohibition + missing-details path tested); application-side evidence banner independent of model honesty
- Regenerate / copy / stop / clear — implemented
- **No auto-speak, no typing into other apps, no auto-submit — none exists** (no code path could do it; the UI states this explicitly)

### Meeting mode
- Current-session-only summaries — implemented (session required unless saved sources explicitly opted in; tested)
- Summary + decisions + action items with owners/deadlines only when stated — implemented via prompt contract ("(not stated)", "[suggested]" separation)
- Uncertainty marking — implemented via prompt contract ("## Uncertain / needs follow-up", "Interpretation:" labels)
- Questions about the current meeting — implemented (strictly session-only retrieval; docs/profile hard-disabled in the request, tested)
- Editable notes before export — implemented (generated notes load into an editable textarea)
- Markdown/TXT export through a safe user-initiated save dialog — implemented (main-process `showSaveDialog`; renderer sends content only, never a path; payload capped at 1 MB)
- No automatic recording on launch — preserved (nothing changed in capture lifecycle; capture remains button-driven)

### Shared
- Visible mode/session/provider status, capture controls stay in the Live tab (single source of truth for capture)
- Loading (streaming text), error, cancel, retry (regenerate), copy, clear states in both panels
- Source attribution for context used — both panels render the per-request source list with match scores
- Keyboard accessibility via native controls; existing themes apply (CSS variables only)
- No duplication: no second ContextEngine, no second provider implementation — ModesService is a consumer of both

## Privacy & security posture

- Capture consent (`PermissionGate`) untouched; modes cannot arm capture; nothing records at launch.
- Cross-session fusion impossible: retrieval is session-tag-filtered (Stage 7 guarantees, re-tested through Stage 8 paths).
- All mode IPC payloads schema-validated with tight bounds (question ≤2 000 chars, export ≤1 MB, no path fields anywhere — pinned by tests).
- Credentials stay in the main process; transcript/document content is fenced as untrusted data in prompts.
- No logging of transcript or note content was added (mode events carry generated text to the UI only).

## Test results (actual)

- `tsc --noEmit` node + web: **0 errors**
- `vitest run`: **179/179 passed, 27 files** = 149 Stage 0–7 regression (green) + 30 new: question detection incl. false positives & determinism (8), prompt contracts incl. fabrication prohibition + STAR + meeting rules (11), ModesService incl. evidence flags, session-only meeting Q&A, single-slot, cancel-vs-error, foreign-session segments, dedupe (17 incl. helper suites), Stage 8 IPC schemas incl. "no path field" shape pin (4). Test-driven fixes: discourse-marker stripping added to the detector ("Then tell me…" was initially missed); cancel-detection signal checks added to the fake provider (product code unchanged by that one).
- `electron-vite build`: success · smoke launch passed (4 electron.exe processes, clean close).

## Performance

No new heavy computation: detection is O(sentences × markers) per segment; prompt building is string assembly; retrieval was measured in Stage 7 (~12–14 ms avg). No dedicated Stage 8 perf numbers collected — nothing above the Stage 7 envelope was introduced.

## Known limitations / unverified

1. **Real-provider behavior still unverified** (pending credentials — unchanged from Stage 6/7): answer quality, summary quality, and model adherence to the fabrication/uncertainty prompt contracts can only be proven with a live model. Mocked tests verify prompt construction, orchestration, cancellation, and error paths.
2. Question detection is heuristic; precision/recall beyond the tested cases is not measured (no labeled dataset — documented, not claimed).
3. Meeting "confirmed vs interpretation" separation is prompt-enforced; the app cannot independently verify model compliance.
4. Speaker attribution and diarization remain out of scope (Stage 5 limitation, unchanged).
5. Exported file location is user-chosen per export; no export history is kept.
6. Interview mode deliberately has no live-question auto-answer loop — answers generate only on click, per spec.

## Completion gate

Regression suite ✅ (179/179) · both typechecks ✅ · production build ✅ · end-to-end mocked workflows for both modes ✅ (detection → retrieval → prompt → streaming → result/attribution → export path) · docs updated ✅. **Real-provider verification remains pending and is the only open item.** Stage 9 not started.
