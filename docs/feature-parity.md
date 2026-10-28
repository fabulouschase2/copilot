# Feature Parity Checklist

*Live checklist (spec §16). Statuses: **implemented** / **partial** / **blocked** / **not implemented**. Updated per stage; evidence links point to stage reports.*

## Module A — Real-time audio engine

| Item | Status | Evidence |
|---|---|---|
| Microphone capture with explicit permission | implemented | `PermissionGate` + getUserMedia; stage-5 report |
| System-loopback capture (Windows) | implemented (Windows only) | `setDisplayMediaRequestHandler` + `audio:'loopback'` |
| Separate mic/system sources | implemented | TranscriptPanel source selector |
| Mic device selection | implemented | enumerateDevices picker (loopback device choice is an OS limitation) |
| Voice activity detection | implemented | `EnergyVad` (hysteresis, preroll, hangover, max-segment) |
| Streaming STT (partial + final) | implemented (adapter-dependent) | Deepgram partials; segment adapters are final-only by capability flag |
| Speaker labeling | not implemented | Stage 8 candidate; needs provider diarization support |
| Pause / resume / mute / stop | implemented | session state machine + tests |
| Device-disconnect recovery | implemented | `track.onended` → clean stop + user-visible reason |
| Recording indicator | implemented | pulsing dot + source + provider + VAD state |
| Local STT engine (whisper.cpp) | implemented (adapter path) | `stt-segment` against a local `/v1` endpoint; not bundled (RAM policy) |

## Module B — Screen understanding

| Item | Status | Evidence |
|---|---|---|
| Screen/window source selection with thumbnails | implemented (Stage 6) | stage-6 report; `screen:sources` |
| One-shot capture + preview + clear-image | implemented (Stage 6) | real-capture self-test |
| Vision analysis via user-configured provider (streaming) | implemented (Stage 6) | `VisionAnalyzer` tests; real-provider E2E pending credentials |
| Region capture pipeline (crop, re-encode) | implemented (pipeline + tests); interactive region UI deferred | stage-6 report |
| Screenshot duplicate detection + diff indicator | implemented | aHash/HashRing; verified on real captures (similarity 1.0 → skip) |
| Screenshot + transcript combined analysis (opt-in, current session only) | implemented | screen-service tests |
| Context integration (text observations, never images) | implemented | tested contract |
| Local OCR engine | not implemented (RAM policy; provider-mediated extraction) | stage-6 report |
| Continuous/background capture | intentionally not implemented (consent model) | architecture.md |

## Module C — Live context engine

| Item | Status | Evidence |
|---|---|---|
| Rolling window, dedup, budgets, pinned items | implemented | context-engine tests |
| Transcript source feeding | implemented (Stage 5) | `TranscriptService.publish → ContextEngine.add` |
| Screen observation feeding (text) | implemented (Stage 6) | screen-service context test |
| Document import (.txt/.md) with validation, preview, remove | implemented (Stage 7) | stage-7 report |
| Editable profile facts (user-authored only) | implemented (Stage 7) | context-service tests |
| Deterministic relevance ranking with reasons + budgets | implemented (Stage 7) | eval: top-1 6/6 on labeled set |
| Session isolation + hard reset on new session | implemented (Stage 7) | adversarial isolation tests |
| Context preview / exclusions / clear controls | implemented (Stage 7) | Context tab |
| Semantic (embedding) retrieval | not implemented (by design this stage) |

## Module D — AI response engine

| Item | Status | Evidence |
|---|---|---|
| OpenAI-compatible streaming chat (hosted + local) | implemented | stage-1-4 report |
| Hot provider switching, latency metrics, cancellation | implemented | stage-1-4 report |
| Vision-capable requests (image + text parts, streaming) | implemented (Stage 6) | `resolveVision()` + vision payload tests |
| Provider fallback chain | not implemented (design exists) |

## Module E — Interview assistant / Module F — Meeting copilot

| Item | Status | Evidence |
|---|---|---|
| Question detection (live transcript + manual), conservative | implemented (Stage 8) | detection tests incl. false positives |
| Style-controlled answer generation (concise/detailed/technical/STAR) | implemented (Stage 8) | prompt-contract tests |
| Evidence sufficiency flags + anti-fabrication prompt contract | implemented (Stage 8) | prompts + modes tests |
| Question feed, regenerate/copy/stop/clear | implemented (Stage 8) | InterviewPanel |
| Meeting summary + decisions + action items (evidence-only owners/deadlines) | implemented (Stage 8) | prompt-contract tests |
| Current-session-only meeting Q&A | implemented (Stage 8) | modes tests (hard-locked options) |
| Editable notes + Markdown/TXT export via save dialog | implemented (Stage 8) | schema shape pin (no path field) |
| Auto-speak / auto-typing / live answer delivery | intentionally absent | spec §8 prohibition |
| Speaker diarization for meetings | not implemented (Stage 5 limitation) |
| Interview-first landing UI + resume/screen quick actions + Coding style | implemented (Stage 10) | InterviewPanel |
| Production-render verification (preload bundling, GPU presentation) | fixed + regression-tested (SF-1, SF-7) | stage-10 report |

## Module G — Desktop interface

| Item | Status |
|---|---|
| Floating window, pin, themes, shortcuts, tabs | implemented (Stage 3) |
| Live transcript panel with partials | implemented (Stage 5) |
| Font-size controls, accessibility pass | not implemented (Stage 10) |

## Module H — Knowledge & memory / Module I — Provider manager / Module J — Security

| Item | Status | Evidence |
|---|---|---|
| Chat + STT provider manager, secure keys, connectivity tests | implemented | stage-1-4 report; Stage 5 adds STT rows |
| Unified context retrieval into chat with budgets + fallback | implemented (Stage 7) | chat-context tests |
| Knowledge storage: SQLite repository, WAL, constraints, backups | implemented (Stage 9) | stage-9 report; production launch verified |
| Legacy JSON→SQLite migration (backup, idempotent, quarantine, rollback) | implemented (Stage 9) | migration tests |
| Backup + restore with never-overwrite-the-only-copy semantics | implemented (Stage 9) | sqlite-store tests |
| Encryption at rest for knowledge DB | not implemented (documented limitation) |
| PDF resume import | implemented (pdf-parse, bounded, tested vs real PDF) |
| Local-only storage / SQLite history | not implemented (Stage 9) |
| Sandbox, CSP, validated IPC, encrypted keys, permission gate | implemented | protocol-stage5 tests; permission-gate tests |
| Export/delete controls | not implemented (Stage 9) |

## Deliberate exclusions (per spec §8/§10/§13 — not gaps)

- Capture-invisible overlay, display-affinity concealment, autotyper, stealth recording, "undetectability" claims.
