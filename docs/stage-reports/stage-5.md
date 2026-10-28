# Stage Report — Stage 5: Streaming Transcription (2026-10-24)

## Files created or changed

**New (main process):**
- `src/main/services/audio/pcm.ts` — base64↔PCM16, RMS dBFS, WAV encoder
- `src/main/services/audio/vad.ts` — `EnergyVad` (hysteresis, pre-roll, hangover, max-segment flush)
- `src/main/services/audio/permission-gate.ts` — one-shot TTL capture approvals
- `src/main/services/stt/types.ts` — adapter contract with explicit capability flags
- `src/main/services/stt/segment-stt.ts` — OpenAI-compatible `/audio/transcriptions` adapter
- `src/main/services/stt/deepgram-stt.ts` — Deepgram WebSocket streaming adapter (injectable socket)
- `src/main/services/stt/stt-registry.ts` — settings+credentials → active adapter
- `src/main/services/transcription-service.ts` — session state machine, VAD wiring, serialized publication, dedup, ContextEngine feed, metrics

**New (renderer):** `src/renderer/public/pcm-worklet.js` (auditable capture worklet), `src/renderer/src/audio/capture.ts` (mic/loopback, resample→PCM16→IPC, worklet + ScriptProcessor fallback), `src/renderer/src/TranscriptPanel.tsx` (consent, controls, live transcript)
**Changed:** `src/shared/protocol.ts` (transcript channels/schemas/types, STT settings), `src/main/ipc.ts`, `src/main/index.ts` (permission handlers, wiring), `src/preload/index.ts`, `src/renderer/src/App.tsx` (Live tab), `SettingsPage.tsx` (STT section), `theme.css`
**Tests:** `tests/pcm.test.ts`, `tests/vad.test.ts`, `tests/stt-adapters.test.ts`, `tests/transcription-service.test.ts`, `tests/permission-gate.test.ts`, `tests/protocol-stage5.test.ts`, `tests/perf-stage5.test.ts`
**Docs:** this report, `docs/architecture.md` (Stage 5 section), `docs/feature-parity.md` (new), `README.md`

**Dependencies added: none.** (fetch/FormData/Blob/WebSocket are built into Node 26/Electron 38.)

## Objectives → status

1. Mic capture + explicit permission + status — **implemented** (one-shot `PermissionGate` armed only on Start; pulsing indicator).
2. System-loopback — **implemented on Windows** via `setDisplayMediaRequestHandler` + `audio: 'loopback'` (WASAPI loopback). macOS/Linux: **not supported this stage** (documented limitation).
3. VAD — **implemented** (`EnergyVad`): 10 ms RMS frames, open at −45 dBFS for 120 ms, close after 700 ms hangover, 300 ms pre-roll, force-close at 20 s (configurable).
4. Pluggable STT with streaming — **implemented**: `stt-segment` (batch, final-only, honest capability flag) + `stt-stream` (genuine WebSocket partials+finals). UI never fakes partials.
5. Timestamped segments → ContextEngine — **implemented** (ordered, deduplicated, through `ContextEngine.add`).
6. Controls — **implemented**: Start/Pause/Resume/Mute/Stop; Pause flushes the open utterance; Stop aborts before flushing and releases all capture resources.
7. Failure handling — **implemented + tested**: permission denial (`CaptureError:denied`), missing device, track-ended disconnect, STT 401/404/429/5xx mapping, network failure, cancellation.
8. Configurable STT providers — **implemented** in Settings (kind/baseUrl/model/language per row; active selection hot-applies next session).
9. Trust boundary — **maintained**: renderer is a sensor (no keys, no STT, no persistence); all validation at the IPC boundary (≤64 KiB chunks, base64-strict, session-scoped).
10. Measurement — **done on this machine** (below).

## Test results (actual)

- `tsc --noEmit` main + renderer: **0 errors**
- `vitest run`: **75/75 passed, 12 files** (32 pre-existing + 43 new). Includes: VAD transitions/hysteresis/preroll/force-flush (7), PCM/WAV (4), SegmentStt multipart/auth/network/cancel (4), Deepgram partials/finals/unexpected-close/queueing (5), service ordering-out-of-order/dedup/pause-flush/mute/stop-abort/seq-accounting/context-integration (9), permission gate TTL/one-shot/independence (6), IPC boundary security incl. buffer-bomb guard (6), perf (2).
- `electron-vite build`: **success**; smoke launch **passed** (4 electron.exe processes, closed cleanly); `pcm-worklet.js` verified in `out/renderer/`.
- Fixes made during verification (found by the tests themselves): b64 cap corrected to 64 KiB decoded; publication reordered via a promise chain after the reorder-buffer approach proved leaky; first chunk no longer counted as a gap; VAD duration assertion accounts for pre-roll.

## Measured performance (this machine: Windows 11 laptop, Node 26, vitest run)

| Metric | Result |
|---|---|
| VAD hot path throughput (decode + RMS + state machine, 60 min synthetic audio) | **3,399× realtime**; 1.06 s wall; **0.029 % of one core** |
| Full pipeline 60 s session (chunks→VAD→dispatch→publish, instant mock STT) | **1,671× realtime** (35.9 ms wall) — pipeline overhead negligible; live latency will be STT-round-trip dominated |
| RSS delta during 60 min VAD run | ~39 MB (includes test allocations; steady-state service is lighter) |
| STT RTT with real providers | **instrumented but not yet measured** — requires live credentials (avg/last RTT tracked in `TranscriptMetrics` and shown at Stop) |

Not yet measured end-to-end with real audio hardware/mics (manual pass pending user); adapter RTT numbers will populate the same metrics.

## Known limitations

1. **Loopback is Windows-only** this stage; on macOS a virtual-device/driver (BlackHole etc.) would be needed.
2. Loopback captures the **default output device** only (Chromium limitation); mic device is selectable.
3. `stt-segment` has no partials by design (batch APIs); choose a `stt-stream` provider for interim text.
4. Deepgram auth uses the `token` subprotocol workaround (browser-style WebSocket cannot set headers).
5. Single live session at a time; concurrent mic+system capture is a Stage 8+ candidate.
6. Renderer capture cannot be moved out-of-process without a native module (platform reality); mitigations documented in architecture.md.
7. No speaker diarization yet.

## Outstanding → Stage 6

Screen understanding (`desktopCapturer` + region/window/region selection, vision adapters through the provider interface, screenshot diff gating, consent flow). Stage 5 is complete and verified; Stage 6 not started.
