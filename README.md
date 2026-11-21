# Copilot

An original, all-in-one real-time AI desktop copilot: interview-first assistance, spoken practice
interviews with scorecards, complete meeting notes, live transcription, screen understanding, and
multi-provider streaming chat — with user-controlled context, personal profiles, and local-first
storage. Built with Electron 38 + TypeScript + React 19.

## Status (0.3.0 — overlay, local STT, translation, story bank)

| Area | Scope | Status |
|---|---|---|
| Stages 1–10 | Original roadmap (research → architecture → providers → transcription → screen → context → modes → persistence → security) | ✅ implemented, 374 tests |
| Transformation | Poisely-inspired product rebuild: new design system + shell, Interview / Practice / Meetings / Chat navigation | ✅ implemented |
| Practice interviews | 7 interview types, difficulty + length, spoken questions (TTS), typed or spoken answers, rubric evaluation per answer, final scorecard with per-dimension scores and improved answers, session history | ✅ implemented |
| Meetings | Independent before/during/after lifecycle: title + audio source + language + provider display → recording with pause/resume/mute and timestamped, source-attributed transcript → auto-generated summary on end, editable notes, structured action items, save/search/reopen/delete/export, ask questions about saved meetings | ✅ implemented |
| Personal profiles | Multiple named profiles, per-profile facts, active profile scoping for retrieval and practice | ✅ implemented |
| Session isolation | Purpose-tagged transcription sessions (`interview` / `meeting` / `practice`) — transcripts never leak across workflows | ✅ implemented |
| Packaging | NSIS installer built, installed and launch-verified (`dist/Copilot-Setup-0.2.1.exe`) | ✅ verified |
| Private overlay | Frameless always-on-top captions/answer window; Windows `WDA_EXCLUDEFROMCAPTURE` with OS-confirmed status; `Ctrl+Alt+O`; measured 8.21% → 0% captured pixels | ✅ implemented, capture exclusion measured |
| Local Whisper | Managed whisper.cpp server: detection, start/stop, readiness, crash reporting; `/inference` adapter; 11 s audio → 0.53 s on CPU | ✅ implemented, real audio verified |
| Live translation | 49 target languages on the active provider; per-line provider attribution; translated captions mirrored to the overlay | ✅ implemented, verified with a local model |
| Career story bank | STAR/CAR/PAR/SOAR/answer-first, deterministic relevance, fact-grounded drafts; auto-attached to interview prompts; schema v4 | ✅ implemented, real draft verified |
| Audio pipeline | **Fixed & verified with real audio on Windows (dev + installed)**: renderer capture wiring + Electron getDisplayMedia permission flow; honest state reporting via the new Audio diagnostics view | ✅ real-audio verified |
| Transcription E2E | Real STT requests reach the provider; results **BLOCKED on the user saving a Groq API key** (the provider returns 401, surfaced verbatim). Pipeline verified end-to-end up to the credential boundary; once a key is saved, transcription works. | BLOCKED (one-time user action) |
| Speaker diarization | Not implemented — segments are labeled by capture source (Mic vs System) only, never presented as speaker identities | — honest exclusion |
| Real-audio E2E | Blocked on the user configuring an STT credential (pipeline covered by integration tests with mock STT) | BLOCKED (user action) |

Full detail: `docs/full-functionality-audit.md` (v0.2.1 audit: every feature, real-audio evidence,
blockers) · `docs/transformation-report.md` (what changed and why) · `docs/feature-parity.md` ·
stage reports in `docs/stage-reports/`.

**Design exclusions** (deliberate): no answer autotyping, no stealth recording, no proctoring
evasion. The private overlay (Phase 6) is a *visible* window that Windows excludes from capture
where supported — the app always reports the OS-confirmed affinity, never the request. See
`docs/overlay-capture-exclusion.md`.

## Setup

Requirements: Windows 10/11 (primary), Node.js ≥ 20, npm ≥ 10.

```bash
npm install
npm run dev        # launch the app with hot reload
npm run build      # production build (out/)
npm test           # unit tests (vitest, 374 tests)
npm run typecheck  # tsc for main + renderer
npm run dist       # production build + NSIS installer (dist/)
```

If npm's script-approval blocked the Electron binary download (npm 11+):

```bash
npm install-scripts approve electron
node node_modules/electron/install.js
```

## Configure a provider

**Settings** → **Providers**. Any OpenAI-compatible endpoint works:

| Provider | Base URL | API key |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | required (AI Studio) |
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Groq | `https://api.groq.com/openai/v1` | required |
| Ollama (local, free) | `http://localhost:11434/v1` | not needed |
| LM Studio (local, free) | `http://localhost:1234/v1` | not needed |

Enter a model name, **Save key** (stored OS-encrypted, never in the renderer), **Test connection**
(shows measured latency), pick the active provider — switching applies to your next message, no
restart. Tick **"model accepts images"** for vision.

**Transcription providers** (Settings → provider list): `stt-segment` (OpenAI-style
`/audio/transcriptions`: Groq `whisper-large-v3`, OpenAI `whisper-1`, local whisper.cpp) transcribes
each VAD utterance; `stt-stream` (Deepgram WebSocket) gives live interim results.

## Interview (landing view)

Start a session (mic or system audio, selectable right in the session bar) — the status dot and
badge show exactly what is being captured ("System audio", "hearing speech" / "silent"), and the
🎚 **Audio** header button opens a diagnostics view of the whole pipeline (capture state, sample
rate, chunks, VAD, STT provider + key presence, last error). Recognized questions fill the
interviewer panel with a live transcript drawer; or type a question. Pick a mode (**Research, Behavioral (STAR), Coding, Technical,
Concise, Detailed**) and a separate **Length** control, press **Answer**. Quick actions:
**🖥 Read screen** (consent-gated modal with source picker, region select and retry). Answers cite
their sources, show provider-reported token usage, and warn when your resume/profile lack the
relevant experience — your experience is never invented. Always manual: nothing is spoken, typed
elsewhere, or submitted.

## Practice

A complete mock-interview system: choose a type (behavioral, technical, software engineering,
coding, system design, AI/QA evaluation, custom), difficulty, question count, optional job
description and role. Questions arrive one at a time and can be read aloud (built-in speech
synthesis). Answer by typing or speaking (transcribed through the practice-purpose session). Every
answer gets an explicit rubric evaluation (Communication, Technical accuracy, Relevance,
Completeness, Problem solving) with strengths, improvements and a suggested improved answer built
only from what you said. The final scorecard summarizes all dimensions with areas for improvement.
Sessions persist and can be reopened.

## Meetings

Before: title, audio source, language, transcription provider shown. During: Start/End controls,
pause/resume/mute, live timestamped transcript with source attribution (Mic = you, System = other
audio), elapsed timer, graceful device-loss handling. After: the summary generates automatically
when you end the meeting, notes stay editable, action items are structured with evidence-only
owners/deadlines ("(not stated)" when absent), and you can save, search, reopen, delete and export
(MD/TXT) meetings — plus ask questions about any saved meeting's transcript. Meeting sessions are
separate from interview sessions; transcripts never cross.

## Career stories

**Stories** keeps your own experiences in STAR, CAR, PAR, SOAR or answer-first form. Search
them, edit them, or draft from the facts you confirmed in Settings — drafts always land in the
editor for review and are never saved automatically. The Interview view attaches the most
relevant stories (max 3) to your question, with the match reason recorded in the sources list.

## Live translation

**Translate** captures mic or system audio and translates each finalized line into one of 49
target languages using the active chat provider. Each line shows which provider produced it;
failed lines show the error. Translated captions also appear in the private overlay. The queue
is bounded, so slow models drop old lines (and say so) instead of falling minutes behind.

## Private overlay

**Overlay** opens a frameless, always-on-top window with live captions and the latest answer
(`Ctrl+Alt+O`). On Windows 10 2004+ the window is marked `WDA_EXCLUDEFROMCAPTURE`, so capture
APIs that honour the flag omit it. The panel shows the OS-reported affinity — not the setting
you asked for — plus the Win32 error code when the call fails. Measured: entire-screen sharing,
GDI recording and PrintWindow omit it; sharing *this specific window* (window-source capture) still
shows it. See `docs/overlay-capture-exclusion.md` for the measured matrix and limits.

## Screen analysis

**Read screen** opens a modal: pick an entire screen or a window, choose a preset (Explain screen ·
Answer visible question · Solve coding problem) or ask your own, optionally drag a region on the
capture preview and re-analyze the selection. One capture per click, nothing in the background,
duplicate screens skip the provider call, provider errors surface verbatim, Retry included.

## Context & data storage

**Settings → Profile & context**: multiple named personal profiles (facts are scoped per profile),
résumé import (PDF/TXT/MD), job description, retrieval preview showing exactly what a question
would retrieve and why. **Response language** (Settings → Response & listening) applies to
interview answers, meeting notes, chat and practice. Storage is local SQLite (`context.db`, schema
v3: documents, per-profile facts, profiles, meetings with metadata, practice sessions and turns) —
no encryption at rest — with **Back up now / Restore latest backup** controls. Transcripts, screen
observations, audio, and screenshots are never persisted; session data never survives into a new
session. Window position/size persist across restarts.

## Shortcuts & privacy

- `Ctrl+Alt+C` — show/hide the window · `Ctrl+Alt+R` — read screen · `Ctrl+Alt+E` — end session
- In-app: `Ctrl+Enter` answer · `Shift+Enter` newline · Stop/Regenerate/Copy on every generation
- Keys OS-encrypted (DPAPI), decrypted only in the main process; sandboxed renderer; schema-validated IPC; CSP locked to `self`
- Capture requires explicit consent per session and cannot re-arm itself
- Free API tiers may use submitted content for product improvement — don't route confidential material through them

## Layout

```
docs/            research, architecture, parity, transformation report, stage reports
src/shared/      IPC contract (zod schemas) — single source of truth
src/main/        window, IPC, services (chat/STT/modes/practice/context/screen/storage)
src/preload/     typed contextBridge (bundled for sandbox; no Node in renderer)
src/renderer/    React UI (interview-first shell: Interview · Practice · Meetings · Chat)
tests/           vitest unit tests (374 as of 0.3.1)
```
