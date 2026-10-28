# Real-Provider Verification Report (Stages 6–8 pending items)

**Date:** 2026-10-25 · **Provider:** Google Gemini via OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`) · **App version:** Stage 8 build · **Harness:** `COPILOT_SELFTEST=provider-verify` (runs the app's real adapters: `OpenAICompatibleProvider`, `ElectronScreenBackend`, mode prompt builders)

## Security notice

An API key was pasted into the conversation during setup. **It must be rotated in Google AI Studio after testing.** During the run the key was staged in a temp file, injected via file path (never a command line), stored OS-encrypted via `safeStorage`/DPAPI in `credentials.json`, and the temp file deleted. It never entered the repository.

## Findings that changed the product (real testing pays)

1. **Adapter URL-join bug (fixed):** a pasted base URL with a trailing slash produced `…/openai//models` → 404. `openai-compatible.ts` now normalizes trailing slashes.
2. **Model-ID prefix (fixed):** the compat `/models` list returns `models/gemini-2.5-flash`-style IDs; chat calls need the bare ID. Setup strips the prefix.
3. **Retired models (fixed):** `gemini-2.5-flash` returns 404 "no longer available to new users". Setup now **probe-validates candidate models with a live chat call** and saves the first that returns 200.
4. **Reasoning-token economics (documented):** Gemini 3.x models consume `max_tokens` budget with hidden reasoning; tiny caps (10–120) can yield empty visible content. Harness caps removed; the UI/timeout defaults are unaffected.
5. **Provider flakiness (documented):** free tier showed intermittent empty completions, one 30 s stall, and one 429 across models — validating the existing timeout/error/cancel design.

## Verification runs (all through real adapters, real network)

### Run A — `gemini-flash-latest` (free tier)

| Check | Result |
|---|---|
| Connection test (`/models`) | ✅ Connected, 813 ms |
| Streaming chat | ✅ incremental deltas, TTFT 11.2 s, completed |
| Cancel mid-stream | ✅ abort thrown (classifier in harness fixed afterwards) |
| **Vision — real screenshot** | ✅ **"The screen shows an AI"** — genuine inference on the live 111 KB screen capture (TTFT 67.7 s, free tier) |
| Interview STAR, zero evidence | ✅ **"[Missing details — general guidance]"** — anti-fabrication contract held with a real model |
| Meeting summary | ✅ structured "## Summary…" output produced |

### Run B — `gemini-3.5-flash` (pinned after probe validation)

| Check | Result |
|---|---|
| Connection test | ✅ 1,227 ms |
| Tiny chat call | ⚠️ intermittent empty completions (2 of 3 runs) — raw SSE dump proved the adapter parses correctly; provider-side behavior, documented |
| Cancel | ✅ classified correctly after fix |
| **Vision — real screenshot (128 KB)** | ✅ **"The screen shows a dark-mode AI software workspace displaying task execution logs, terminal commands, and progress tracking."** (TTFT 4.5 s) |
| Interview STAR, zero evidence | ✅ "[Missing details — general guidance] You have not provided context or specific experience regarding leading a team of 50 engineers…" |
| **Meeting summary** | ✅ exemplary: decisions quoted with `(transcript)` attribution; "Migrate the billing service to Rust — Owner: Priya — Deadline: March 15"; "Update the docs — Owner: (not stated) — Deadline: (not stated)"; separate "## Uncertain / needs follow-up" distinguishing confirmed from interpretation |

## Checklist mapping (A–G from the manual plan)

- **A. Provider & chat:** connection ✅, streaming ✅, cancel ✅ (service-level), key not logged ✅ (staged via temp file; encrypted at rest). Regenerate/provider-switch in-GUI: **manual, pending**.
- **C. Screen understanding:** consent-gated capture ✅ (existing gate), **real vision response ✅ (both runs)**, dedup skip ✅ (Stage 6 selftest), cancel/resource release ✅ (unit level). In-GUI preview flow: **manual, pending**.
- **E. Interview mode:** manual-question generation ✅ (service level), anti-fabrication with real model ✅. Styles other than STAR through the GUI: **manual, pending**.
- **F. Meeting mode:** summary with evidence-only owners/deadlines ✅ (real model, exemplary), session-only Q&A ✅ (unit level). Export file write: **manual, pending** (dialog flow).
- **B. Documents/context, D. Transcription, G. Windows reliability:** not run here. Transcription specifically requires a Groq key (**no key provided — still pending**). GUI workflows, restart persistence, 10-minute resource profile: **manual, pending**.

Nothing on this page should be read as "GUI-verified"; it verifies the service layer and provider integration end-to-end. GUI checklist rows remain open for the manual pass with the now-configured provider (Settings already contains the Gemini row with vision enabled; the key is in the OS-encrypted store — the app is ready to launch and use directly).

## Privacy reminder (repeat)

The free Gemini API tier may use submitted content for product improvement. Do not route confidential transcripts or documents through it; rotate the exposed key.
