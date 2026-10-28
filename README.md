# Copilot

An original, all-in-one real-time AI desktop copilot: interview-first assistance, meeting notes, live transcription, screen understanding, and multi-provider streaming chat — with user-controlled context and local-first storage. Built with Electron 38 + TypeScript + React 19.

## Status (Stage 10)

| Stage | Scope | Status |
|---|---|---|
| 1 | Product research + feature comparison | ✅ `docs/product-research.md`, `feature-comparison.md`, `feature-evidence.md` |
| 2 | Requirements + architecture | ✅ `docs/architecture.md` |
| 3 | Desktop shell + interface | ✅ implemented |
| 4 | Provider abstraction + streaming chat | ✅ implemented (OpenAI-compatible: hosted + local; hot switching) |
| 5 | Streaming transcription (audio) | ✅ implemented (mic + Windows loopback, VAD, segment/stream STT adapters) |
| 6 | Screen capture + vision | ✅ implemented (+ real-vision verification, see below) |
| 7 | Unified context engine | ✅ implemented (documents + profile + session retrieval, deterministic ranking) |
| 8 | Interview + meeting modes | ✅ implemented (question detection, STAR/Coding styles, summaries, exports) |
| — | Real-provider verification | ✅ passed with Gemini (chat, cancel, real vision, interview anti-fabrication, meeting extraction) — `docs/real-provider-verification.md` |
| 9 | SQLite persistence + safe migration | ✅ implemented (node:sqlite, WAL, JSON→SQLite migration, backup/restore) |
| 10 | Security hardening + UI simplification | ✅ implemented (production preload crash fixed, GPU presentation fixed, PDF resumes, interview-first UI, threat model + security regression tests; 211 tests) |

Full per-module detail: `docs/feature-parity.md` · stage reports: `docs/stage-reports/`.

**Design exclusions** (deliberate, per spec): no capture-invisible overlay, no answer autotyping, no stealth recording. This is a visible-window, consent-based assistant.

## Setup

Requirements: Windows 10/11 (primary), Node.js ≥ 20, npm ≥ 10.

```bash
npm install
npm run dev        # launch the app with hot reload
npm run build      # production build (out/)
npm test           # unit tests (vitest)
npm run typecheck  # tsc for main + renderer
```

If npm's script-approval blocked the Electron binary download (npm 11+):

```bash
npm install-scripts approve electron
node node_modules/electron/install.js
```

## Configure a provider

**Settings** → **+ Add provider**. Any OpenAI-compatible endpoint works:

| Provider | Base URL | API key |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | required (AI Studio) |
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Groq | `https://api.groq.com/openai/v1` | required |
| Ollama (local, free) | `http://localhost:11434/v1` | not needed |
| LM Studio (local, free) | `http://localhost:1234/v1` | not needed |

Enter a model name, **Save key** (stored OS-encrypted, never in the renderer), **Test connection** (shows measured latency), pick the active provider — switching applies to your next message, no restart. Tick **"model accepts images"** for vision.

**Transcription providers** (Settings → Transcription): `stt-segment` (OpenAI-style `/audio/transcriptions`: Groq `whisper-large-v3`, OpenAI `whisper-1`, local whisper.cpp) transcribes each VAD utterance; `stt-stream` (Deepgram WebSocket) gives live interim results.

Cloud-first is the recommended default on modest hardware; local models are optional and never bundled.

## Interview (landing view)

Paste or type the question, pick a style (**STAR, Coding, Concise, Detailed, Technical**), press **Answer**. Quick actions: **📄 Resume** (PDF/TXT/MD import) and **🖥️ Read screen** (consent-gated, visible capture). Detected questions from the live session appear automatically. Answers cite their sources and warn when your resume/profile lack the relevant experience — your experience is never invented. Always manual: nothing is spoken, typed elsewhere, or submitted.

## Meeting

**Summarize meeting** / **Extract action items** on the current session only; owners/deadlines appear only when the transcript states them ("(not stated)" otherwise). Ask questions about the meeting, edit the generated notes, export Markdown or plain text via a save dialog.

## Live transcription

**Live** tab → Microphone or System audio (loopback, Windows) → consent → **Start**. Pause/Resume/Mute/Stop; a pulsing indicator shows session state. Finalized utterances feed the AI context engine. Nothing is saved to disk by default.

## Screen analysis

**Screen** tab → enable → pick screen/window → **Analyze screen**. One capture per click, nothing in the background, duplicate screens skip the provider call, timing metrics shown.

## Context & data storage

**Context** tab: import PDF/TXT/MD documents, edit profile facts, exclude sources or categories, preview exactly what a question would retrieve (with reasons), clear session context. Storage is local SQLite (`context.db`; no encryption at rest) with **Back up now / Restore latest backup** controls. Transcripts, screen observations, audio, and screenshots are never persisted; session data never survives into a new session. Window position/size persist across restarts.

## Shortcuts & privacy

- `Ctrl+Alt+C` — show/hide the window · `Enter` send · `Shift+Enter` newline · Stop/Regenerate/Copy on every generation
- Keys OS-encrypted (DPAPI), decrypted only in the main process; sandboxed renderer; schema-validated IPC; CSP locked to `self`
- Capture requires explicit consent per session and cannot re-arm itself
- Free API tiers may use submitted content for product improvement — don't route confidential material through them

## Layout

```
docs/            research, architecture, parity, verification, stage reports
src/shared/      IPC contract (zod schemas) — single source of truth
src/main/        window, IPC, services (chat/STT/modes/context/screen/storage)
src/preload/     typed contextBridge (bundled for sandbox; no Node in renderer)
src/renderer/    React UI (interview-first, meeting, live, screen, files, chat, settings)
tests/           vitest unit tests (217 as of Stage 12)
```
