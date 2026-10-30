# Copilot

An original, all-in-one real-time AI desktop copilot: interview-first assistance, spoken practice
interviews with scorecards, complete meeting notes, live transcription, screen understanding, and
multi-provider streaming chat — with user-controlled context, personal profiles, and local-first
storage. Built with Electron 38 + TypeScript + React 19.

## Status (transformation release 0.2.0)

| Area | Scope | Status |
|---|---|---|
| Stages 1–10 | Original roadmap (research → architecture → providers → transcription → screen → context → modes → persistence → security) | ✅ implemented, 248 tests |
| Transformation | Poisely-inspired product rebuild: new design system + shell, Interview / Practice / Meetings / Chat navigation | ✅ implemented |
| Practice interviews | 7 interview types, difficulty + length, spoken questions (TTS), typed or spoken answers, rubric evaluation per answer, final scorecard with per-dimension scores and improved answers, session history | ✅ implemented |
| Meetings | Independent before/during/after lifecycle: title + audio source + language + provider display → recording with pause/resume/mute and timestamped, source-attributed transcript → auto-generated summary on end, editable notes, structured action items, save/search/reopen/delete/export, ask questions about saved meetings | ✅ implemented |
| Personal profiles | Multiple named profiles, per-profile facts, active profile scoping for retrieval and practice | ✅ implemented |
| Session isolation | Purpose-tagged transcription sessions (`interview` / `meeting` / `practice`) — transcripts never leak across workflows | ✅ implemented |
| Packaging | NSIS installer built, installed and launch-verified (`dist/Copilot-Setup-0.2.0.exe`) | ✅ verified |
| Speaker diarization | Not implemented — segments are labeled by capture source (Mic vs System) only, never presented as speaker identities | — honest exclusion |
| Real-audio E2E | Blocked on the user configuring an STT credential (pipeline covered by integration tests with mock STT) | BLOCKED (user action) |

Full detail: `docs/transformation-report.md` (what changed and why) · `docs/feature-parity.md` ·
stage reports in `docs/stage-reports/`.

**Design exclusions** (deliberate, per spec): no capture-invisible overlay, no answer autotyping, no
stealth recording. This is a visible-window, consent-based assistant.

## Setup

Requirements: Windows 10/11 (primary), Node.js ≥ 20, npm ≥ 10.

```bash
npm install
npm run dev        # launch the app with hot reload
npm run build      # production build (out/)
npm test           # unit tests (vitest, 248 tests)
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

Start a session (mic or system audio) — recognized questions fill the interviewer panel with a live
transcript drawer; or type a question. Pick a mode (**Research, Behavioral (STAR), Coding, Technical,
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
tests/           vitest unit tests (248 as of the 0.2.0 transformation)
```
