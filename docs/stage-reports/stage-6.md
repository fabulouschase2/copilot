# Stage Report — Stage 6: Screen Understanding (2026-10-24)

## Files created or changed

**New (main process):**
- `src/main/services/screen/image-hash.ts` — pure image core: validation (4096 px cap), normalized-rect crop, 16×16 aHash, Hamming similarity, duplicate threshold (0.98), bounded `HashRing`
- `src/main/services/screen/screen-backend.ts` — `ScreenBackend` interface + `ElectronScreenBackend` (main-process `desktopCapturer` + `nativeImage`: capture, resize-to-1280, BGRA→RGBA, JPEG encode, preview encode)
- `src/main/services/screen/screen-service.ts` — orchestrator: consent gate, one-shot captures, crop/hash/dedup, streaming analysis, result structure, cancellation, metrics
- `src/main/services/vision/vision-analyzer.ts` — vision payload builder + streaming via the shared `AIProvider` interface (TTFT tracked)
- `src/main/selftest.ts` — real-capture measurement harness (`COPILOT_SELFTEST=screen`)

**Changed:** `src/shared/protocol.ts` (screen channels/schemas/types, `ContentPart` in `ChatMessage`), `src/main/ipc.ts`, `src/main/index.ts` (screen gate + wiring + selftest hook), `src/main/services/audio/permission-gate.ts` (`'screen'` permission kind), `src/main/services/transcription-service.ts` (bounded recent-transcript ring + accessor; cleared on new session), `src/main/services/provider-registry.ts` (`resolveVision()`), `src/preload/index.ts`
**New (renderer):** `src/renderer/src/ScreenPanel.tsx` (Screen tab)
**Changed (renderer):** `App.tsx` (Screen tab), `theme.css`
**Tests:** `tests/image-hash.test.ts`, `tests/screen-service.test.ts`, `tests/vision-analyzer.test.ts`, `tests/protocol-stage6.test.ts`, `tests/perf-stage6.test.ts`
**Docs:** this report, `docs/architecture.md`, `docs/feature-parity.md`, `README.md`

**Dependencies added: none** (desktopCapturer/nativeImage are built into Electron 38).

## Objectives → status

| Requirement | Status |
|---|---|
| Capture-source selection (screen/window) with previews | implemented (`screen:sources` returns thumbnails; picker in UI) |
| Analysis request structure (question, observations, provider/processing status, transcript refs) | implemented (`ScreenAnalysisResult`) |
| No raw screenshots into text-only context | enforced — ContextEngine receives **text observations only** (tested) |
| Combined analysis: screenshot + selected recent transcript | implemented via opt-in `includeTranscript`; prompt embeds current-session refs |
| Never mix transcripts across sessions | enforced — ring cleared on every new session prepare (tested) |
| Backward compatibility | additive: all Stage 0–5 channels/types unchanged; chat `ChatMessage.content` widened to allow vision parts (renderer chat still sends strings — validated by regression suite) |
| Region capture | **contract + pipeline implemented and tested** (normalized rect, clamped crop, re-encode); interactive region-drawing UI deferred to the overlay stage |
| OCR as a separate local engine | not implemented (per RAM policy — text extraction is provider-mediated via the vision model; documented limitation) |
| UI (Screen tab: selector, preview, prompt, provider, analyze/cancel, processing indicator, results, error/retry, clear-image, diff indicator) | implemented (provider selector = the vision-enabled rows from Settings; explicit "include transcript" toggle) |
| Security: keys in main, IPC validation, size/dimension caps, no content logging, no renderer file reads, cancellation+timeouts, no silent capture restart, explicit remote processing | implemented (details below) |
| Memory-bounded processing | single in-flight request; encoded payload released after send; ≤8-image hash ring; 8 MB payload guard; 4096 px dimension cap |

## Security implementation notes

- **No renderer-controlled file access exists**: the capture schema has no path/image fields (pinned by `protocol-stage6.test.ts`); images are captured in the main process only and flow to the renderer solely as the user's own preview.
- **Consent**: the Screen tab requires enabling "screen analysis" (5-min TTL arm); each Analyze is one discrete capture; there are no timers or continuous capture anywhere, so capture cannot silently restart — re-arming requires a user action. Remote processing is stated in the consent copy (audio) and the tab explainer (screen: "One capture per request").
- **No logging** of screenshots, OCR text, or observations: no `console.log` of image data anywhere in the pipeline (checked); errors carry status/URL-level info only.
- **Timeouts/cancellation**: 90 s analysis deadline via `AbortSignal.any`, user Cancel aborts capture-or-stream mid-flight (tested).

## Test results (actual)

- `tsc --noEmit` main + web: **0 errors**
- `vitest run`: **107/107 passed, 17 files** = 75 Stage 0–5 regression (all green, unmodified) + 32 new: image validation/crop/hash-stability/dedup-ring (10), screen service happy-path/duplicate-skip/region-crop/transcript-refs-no-mixing/cancel/provider-error/invalid-image/clear/single-flight/consent (10), vision payload construction/TTFT/error/cancel (5), Stage 6 IPC boundary incl. "no path field" contract (4), perf (2)
- `electron-vite build`: **success**; smoke launch **passed** (4 electron.exe processes, clean close)
- Test-driven fixes this stage: duplicate detection exposed the aHash degenerate case on solid-color test images (switched to textured fixtures — behavior of the detector was correct); test-harness gate ordering made streams hang (fixed in the fake, not the product).

## Measured performance (this machine: Windows 11 laptop)

**Real captures through the actual Electron backend** (`COPILOT_SELFTEST=screen`, primary display):

| Metric | 1st capture | 2nd capture |
|---|---|---|
| desktopCapturer capture + resize (1280×720) | **290 ms** | **240 ms** |
| aHash + duplicate detection | 31.6 ms | 11.3 ms |
| JPEG encode (analysis payload, 73 KB) | 17 ms | 11 ms |
| Similarity to previous | — (empty ring) | **1.0 → duplicate detected, provider call skipped** |
| RSS | 104 MB | 122 MB |

**Synthetic 1080p benchmarks** (vitest): hash+dedup avg 28–52 ms (varies with machine load; printed per run), 960×540 region crop ≈ 2 ms, bestSimilarity lookup 0.003 ms/call, RSS delta for 100 hashes ≈ 0 (hashes are 256 bits).

**Remote provider latency (TTFT / total)**: fully instrumented (`processing.ttftMs`, `processing.totalMs`, per-request `screen:metrics`) but **not yet measured — requires a real vision-provider credential**. Not invented, per instructions.

## Platform limitations

- Region capture has no interactive overlay UI yet (pipeline supports it; UI in the overlay stage).
- No local OCR engine (RAM policy); text extraction rides on the vision model.
- Window capture lists windows of the current desktop session only (OS behavior).
- `desktopCapturer` thumbnails cap at the 1280 long side — very high-DPI displays are downscaled before analysis (by design, for payload size).

## Completion status

Builds ✅ · typechecks ✅ · full regression suite passes ✅ · **real local capture → preprocessing → dedup → payload construction verified on hardware** ✅ · **end-to-end with a real configured vision provider: pending user credentials** (code path is the same one exercised by tests; 30-second recipe in README §Screen analysis).

## Outstanding → Stage 7

Unified context engine wiring: chat + transcript + screen observations already flow into `ContextEngine`; Stage 7 adds document/profile sources, relevance ranking, and the combined-prompt assembly.
