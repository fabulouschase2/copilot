# Architecture

*Stage 2 deliverable. Contracts defined here are implemented in `src/shared/protocol.ts` and `src/main/services/providers/types.ts`; this doc explains the why.*

## Stack decision

**Electron 38 + TypeScript + React 19 + Vite (electron-vite) + zod. Chosen deliberately.**

| Option | Verdict | Reason |
|---|---|---|
| **Electron + TS** | **chosen** | Windows is the confirmed primary platform (user's machine); Electron gives first-class system-audio capture APIs (`desktopCapturer`, WebAudio loopback on Windows), display-affinity-free windowing (we *want* to be captured), `safeStorage` for key encryption, global shortcuts, multi-display screenshot APIs, and one codebase portable to macOS later — matching Poisely's platform coverage while Tails (macOS-only) and NoteMotion (Windows-only) each cover only half. |
| Tauri + Rust | rejected for now | Smaller binaries, but system-audio loopback capture on Windows requires nontrivial custom Rust (WASAPI) work; team velocity and library ecosystem (screen capture, WASAPI, SSE streaming) favor Electron at this stage. Revisit at packaging stage if memory footprint is unacceptable. |
| Native (WinUI/WPF) | rejected | Windows-only contradicts the portability requirement; slower iteration. |

**Storage:** JSON files in `userData` for settings/credentials (Stage 3–4). SQLite (`better-sqlite3`) lands in Stage 9 for sessions/transcripts/knowledge, with an optional vector index; interface for persistence is already isolated behind stores so the swap is local.

**Resource budget (user requirement): the app must run well on a modest laptop.**
- **Cloud-first by default:** the recommended configuration is one hosted OpenAI-compatible provider (BYO API key). Local models (Ollama/LM Studio) are *supported but optional* — the app never requires them and never bundles a large model. Running multiple large local models simultaneously is explicitly out of scope.
- Electron's baseline footprint (~150–250 MB RAM) is the accepted trade for its Windows system-audio and capture APIs; memory usage becomes a measured metric from Stage 5 onward.
- Rust remains the designated tool if Stage 5 needs a custom WASAPI loopback integration ("Rust desktop and system integration"); the audio-engine interface is designed so a native module can replace the JS capture path without touching call sites.

**Why not more, now:** no library is added until a stage needs it (spec §14). Audio (Stage 5) will use WebAudio capture + pluggable transcription adapters; screen understanding (Stage 6) uses `desktopCapturer` + vision-capable providers through the same provider interface.

## Stage 5 — audio capture and streaming transcription

```
Renderer (untrusted sensor layer)                Main process (trusted)
┌────────────────────────────────┐               ┌──────────────────────────────────────────┐
│ getUserMedia (mic) /           │  ~100 ms b64  │ PermissionGate (one-shot, TTL)           │
│ getDisplayMedia (Win loopback) │──PCM16 16k──▶ │  ▼ zod boundary (≤64 KiB, base64-strict) │
│ AudioWorklet → resample→Int16  │               │ TranscriptService                        │
│ no keys · no persistence       │               │  EnergyVAD ─▶ utterance ─▶ STT adapter   │
└────────────────────────────────┘               │  publish chain (dispatch order = output  │
         ▲ transcript:segment/partial/status      │  order) ─▶ dedup ─▶ ContextEngine.add()  │
         └──────────── events ──────────────────  │  metrics · session state machine         │
                                                  │  STT adapters: SegmentStt | DeepgramStt  │
                                                  └──────────────────────────────────────────┘
```

**Trust boundary.** The renderer necessarily touches the mic/loopback stream (Chromium capture APIs live there) and is treated as a sensor only: it holds no credentials, does no transcription, and writes nothing to disk. VAD, STT calls, transcript state, and keys are main-process only. Capture access is gated by `PermissionGate` (armed exactly once when the user presses Start, consumed by Electron's `setPermissionRequestHandler` / `setDisplayMediaRequestHandler`, 30 s TTL) — a compromised renderer cannot re-arm capture silently.

**STT adapter capabilities (documented, not assumed):**

| Adapter | Transport | Partials | Finals | Endpointing | Examples |
|---|---|---|---|---|---|
| `stt-segment` | HTTP batch per utterance | ✗ (flag says so) | ✓ | our VAD | OpenAI `whisper-1`, Groq `whisper-large-v3`, local whisper.cpp server |
| `stt-stream` | WebSocket (bidirectional) | ✓ interim | ✓ | provider-side (`speech_final`) | Deepgram `nova-2` |

**Ordering & dedup.** Publication is serialized on a promise chain: a segment publishes only after every earlier-dispatched one settles, so out-of-order STT responses are impossible to observe downstream. Duplicates drop on a `(source, startMs, text)` key; the ContextEngine adds a second normalized-text dedup layer. Chunk-sequence replays/gaps are counted, not crashed on; beyond 8 in-flight requests the excess is shed (counted) rather than buffering unbounded audio.

**Controls & lifecycle.** `armed → listening ⇄ paused → stopped` plus an independent mute flag. Pause flushes the half-open utterance to STT (content preserved); Stop aborts in-flight STT *before* flushing so the tail is truly discarded and all capture resources release. Device disconnect (`track.onended`) stops the session and surfaces the reason.

**Data handling.** No raw audio is saved by default; utterance buffers exist only until their STT request settles. Transcript segments are separate objects (never alias audio buffers). Consent: the Start control shows the resolved provider name and cloud/local kind before any capture begins; the recording indicator (pulsing dot + source + provider) is visible whenever audio flows.

## Stage 6 — screen understanding

```
User clicks Analyze (consent armed, 5-min TTL)
  ▼ zod boundary (no path/image fields — capture cannot be renderer-controlled)
ScreenService (main, one-shot, single in-flight)
  ElectronScreenBackend: desktopCapturer → nativeImage resize(≤1280) → BGRA→RGBA
  ▼ optional normalized-rect crop (pure core) → validation (≤4096 px)
  aHash 16×16 → HashRing similarity (≥0.98 ⇒ duplicate → reuse, skip provider)
  ▼ VisionAnalyzer: OpenAI-style vision payload (text + data-URL JPEG)
  streamed through the SAME AIProvider interface (TTFT tracked, 90 s deadline)
  ▼ ScreenAnalysisResult { question, observations, provider, processing, transcriptRefs }
  ContextEngine.add({kind:'screen', text: observations})   ← text only, never images
```

**Consent & lifecycle:** screen analysis is armed by an explicit user toggle (5-minute TTL, separate from the capture-permission gate); every capture is one-shot and bound to an Analyze click. There are no timers and no continuous capture, so capture cannot silently restart — Clear/Stop revoke, and re-arming is a user action. Preview thumbnails shown in the UI are the user's own capture, sent renderer-ward only for display.

**Duplicates:** a 16×16 average hash with Hamming similarity; ≥ 0.98 against the last 8 captures marks the screen unchanged → the previous result stands and no provider call, upload, or context write happens (verified on real captures: second grab of an unchanged screen reported similarity 1.0).

**Transcript fusion:** when the user opts in, the prompt embeds the last ≤20 finalized segments **of the current session only**; the ring is cleared on every new session, so cross-session mixing is impossible by construction.

**Adapter notes:** `ChatMessage.content` widened additively to string | content-parts (renderer chat still sends validated plain strings). `stt-segment`-style OCR engines are intentionally absent (RAM policy) — text extraction is mediated by the vision model; a local OCR adapter can implement the same backend interface later.


## Stage 7 — unified context engine

```
Documents (.txt/.md, dialog import in main)   Profile facts (user-authored)
        │ ContextStore (JSON, local-only)             │
        └──────────────┬───────────────────────────────┘
                       ▼
   ContextService.retrieve(question, options)
     candidates = docs+facts (category on, not excluded)
                + live items tagged with the CURRENT session only
     rank(): IDF-weighted lexical scoring, phrase bonus, type priors,
             recency, near-dup suppression, per-source + total budgets
     → RankedItem[] each with score + human-readable reason
                       ▼
   ChatController: block appended to system prompt (untrusted-data +
   conflict instructions) · onContext event to the UI · budget from
   settings.context (default 1 200 tokens) · retrieval failure is
   reported and chat continues WITHOUT context (never faked)
```

**Session boundaries (hard guarantees):** `beginSession()` (fired when a transcription session is prepared) wipes every session-scoped item; retrieval only ever returns items tagged with the current session; between sessions nothing session-scoped is retrievable. Documents and profile facts persist only because the user created them, and are removable/excludable individually or per category.

**Design stance:** retrieval returns a small, relevant, traceable set — never an automatic memory dump. Ranking is deterministic, dependency-free lexical scoring (no embeddings, no vector DB); every inclusion is explainable and every source attributable. Imported document content is fenced as untrusted data in prompts. Model-visible records never contain credentials, images, or filesystem paths.


## Stage 8 — interview & meeting modes

```
Live transcript segments ──▶ ModesService.observeTranscriptSegment
                                  │ detectQuestions (conservative heuristics)
                                  ▼ question feed (current session only)
User click ──▶ interviewAnswer / meetingGenerate / meetingAsk
                 │ ProviderRegistry.resolveActive (shared)
                 │ ContextService.retrieve (shared budgets/exclusions/session filter)
                 │ prompt builders (fabrication prohibition, STAR labels,
                 │   "(not stated)" owners/deadlines, confirmed vs interpretation)
                 ▼ AIProvider.chatStream (shared streaming/cancel/timeout)
             mode panels: answer + sources + evidence warning · editable notes
                 ▼ user-initiated showSaveDialog (main) → export
```

**Non-negotiables:** answers generate only on explicit user action; nothing is spoken, typed into other applications, or submitted anywhere. The fabrication prohibition is a tested contract of every interview prompt; meeting owners/deadlines must come from the transcript or be marked "(not stated)". Meeting Q&A is hard-locked to the current session. Both modes are consumers of the shared provider, retrieval, and session infrastructure — no parallel engine exists.


## Stage 9 — SQLite persistence

```
ContextService ──▶ SQLiteStore (repository interface, main process only)
                    node:sqlite (built-in; gate-checked in Electron 38)
                    schema v1: documents · profile_facts · exclusions · meta
                    WAL + synchronous=NORMAL · FK on · CHECK constraints ·
                    prepared/parameterized statements only
Migration (startup, once): validate legacy JSON → backup → transactional
  import → count verification → rename to .migrated-<ts> (never delete);
  malformed input quarantined; idempotent by detection + PKs
Backups: VACUUM INTO into userData/backups (WAL-safe), retention 5,
  user-initiated; restore copies (never overwrites the only DB) and swaps
  the live store via ContextService.replaceStore
```

**Persistent:** documents, profile facts, exclusions. **Never persisted:** transcripts, screen observations, audio, screenshots, API keys (OS-encrypted store). SQLite has no encryption at rest — documented; the DB lives plaintext under the user profile behind OS ACLs. Renderer sees neither SQL nor file paths; persistence status is a typed IPC payload.


## Stage 10 — hardening, UI simplification & reliability

**Threat model:** compromised renderer · malicious imported files · untrusted model output · key leakage · provider failures · DB corruption · process termination. Defenses are evidence-linked in `docs/stage-reports/stage-10.md` (findings SF-1…SF-8 with permanent regression tests).

**Key findings fixed this stage (both production-only, found via real GUI verification):**
1. Sandboxed preload could not load externalized `zod` → `window.copilot` undefined → React unmount → **black window**. Preload deps now bundled (SF-1 regression test reads the built bundle).
2. Hybrid-graphics Windows machines presented a black display despite a valid compositor buffer → `app.disableHardwareAcceleration()` (SF-7).

**Standing invariants (regression-tested):** sandbox + contextIsolation + no nodeIntegration; one narrow bridge; CSP `self`; popups denied; no key material in built bundles; PDF import (user requirement) behind the same validation/bounds pipeline as text; window bounds persist; hardware acceleration off.

**UI:** Interview-first landing (Poisely-style flow — question → style pills → grounded answer with sources + evidence warnings; 📄 Resume / 🖥️ Read screen quick actions). No capture evasion: the Read-screen action is consent-gated and visible; the app never hides from screen sharing (documented: sharing a whole display exposes it).

## Component separation (spec §14 mapping)

```
┌────────────────────────── Electron app ──────────────────────────┐
│  Renderer (React, sandboxed, no Node, no secrets)                │
│   UI: ChatPanel · Settings · StatusStrip · Theme                 │
│        ▲ window.copilot (contextBridge, typed)                   │
│  Preload  — validates nothing, only bridges                      │
│        ▲ typed IPC channels (zod-validated in main)              │
│  Main process                                                    │
│   WindowManager      — visible floating window, pin, shortcuts   │
│   ProviderRegistry   — builds chat adapters from settings        │
│   ChatController     — streaming, cancellation, per-request       │
│                         provider resolution (hot switch)         │
│   TranscriptService  — sessions, VAD, STT dispatch, ordering     │
│   ScreenService      — one-shot capture, dedup, vision analysis  │
│   PermissionGate     — one-shot OS capture approvals (Stage 5/6) │
│   ContextEngine      — rolling window, dedup, budgets (Module C) │
│   SettingsStore      — validated JSON persistence (Module I)     │
│   CredentialStore    — safeStorage-encrypted keys (Module J)     │
│   [Stage 5] AudioEngine — capture + VAD + transcription adapters │
│   [Stage 6] ScreenService — desktopCapturer + vision adapters    │
│   [Stage 9] SessionStore — SQLite transcripts/knowledge          │
│   [Stage 10] Hardening — CSP audit, logging redaction            │
└───────────────────────────────────────────────────────────────────┘
```

## Interface contracts

### 1. IPC contract (`src/shared/protocol.ts`)
Single source of truth. Every inbound renderer payload is parsed with zod in the main process; failures return a typed error, never a crash. Channels: `settings:get/set`, `providers:list/test`, `chat:send/cancel` (renderer→main), `chat:chunk/done/error`, `app:status` (main→renderer events). `ProviderInfo` deliberately contains **no key material** — only `hasCredential: boolean`.

### 2. Provider contract (`src/main/services/providers/types.ts`)
```ts
interface AIProvider {
  id, label
  capabilities(): { chat, streaming, vision, transcription }
  chatStream(req: { model, messages, signal?, timeoutMs?, maxTokens? }): AsyncGenerator<StreamChunk>
  testConnection(): Promise<{ ok, message, latencyMs }>
}
```
- **OpenAI-compatible adapter** (implemented) covers OpenAI, OpenRouter, Groq, Together, **Ollama** (`http://localhost:11434/v1`) and **LM Studio** (`http://localhost:1234/v1`) — local models need no key. SSE parsing, `[DONE]` handling, HTTP error mapping (401→"check key", 404→"check model", 429, 5xx), `AbortSignal.any` for cancel+timeout.
- Future adapters (Anthropic Messages, Gemini, Whisper-compatible STT, vision) implement the same interface; the registry is the only place that changes.

### 3. Hot provider switching (user requirement)
`ChatController` resolves the active provider **per request** from the registry, which reads current settings. Switching providers in Settings affects the next message immediately — no restart, no stale handles. `testConnection` returns measured latency, shown in the provider list.

### 4. Context contract (Module C, `context-engine.ts`)
`ContextItem { id, kind: transcript|screen|profile|doc|note, text, timestamp, pinned? }`. `add()` dedups on normalized text; eviction respects `maxItems`/`maxAgeMs` and never evicts pinned items; `build(maxTokens)` selects newest-first within budget, returns chronological; `render()` emits labeled blocks. Stage 7 wires transcript/screen sources into it; the engine itself is already tested.

## Security model (Module J)

1. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; renderer talks only through the typed bridge.
2. CSP in `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.
3. API keys: `safeStorage`-encrypted at rest; decrypted only in main, only at request time; never sent to renderer; never logged. If OS encryption is unavailable the store **refuses** to save (no silent plaintext).
4. All renderer input validated by zod schemas with hard size limits before use.
5. Error events carry human-readable, secret-free messages — no stacks, no URLs with keys.
6. Visible window by default; no display-affinity tricks, no capture exclusion, no autotyper (documented exclusions in `feature-comparison.md`).

## Performance approach (§15)

Baselines will be measured on this machine before targets are frozen. Mechanisms already in place: streaming (first token renders immediately), per-request cancellation, provider latency metrics from `testConnection`, bounded context (`build(maxTokens)`), timeout+abort on every provider call. Planned: transcript partial/final batching (Stage 5), screenshot diff gating (Stage 6), SQLite WAL persistence (Stage 9). Claims of met targets will cite test output, not intentions.

## Testing strategy (§16)

Vitest unit tests for every pure service: provider adapter (mocked fetch/SSE: delta parsing, `[DONE]`, error mapping, auth errors), context engine (dedup, eviction, budgets, pinned), credential store (roundtrip, no-encryption refusal, removal), settings store (defaults, corrupt-file recovery), protocol schemas (rejection of oversized/invalid payloads). E2E (Playwright + Electron) arrives with Stage 11 packaging; stage reports list what is verified vs. unverified.
