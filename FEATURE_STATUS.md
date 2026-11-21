# FEATURE STATUS

Honest, code-level status. "Verified" means it was exercised on this machine and the
evidence is recorded; "implemented" means the code exists and is unit-tested but was
not driven end-to-end with real credentials or hardware.

Last updated: 2026-11-21 (after Phase 6).

| Area | Before this work | Now | Evidence / gap |
|---|---|---|---|
| Live audio capture (mic + Windows loopback) | Working | Working | `docs/full-functionality-audit.md`; audio pipeline tests |
| Live transcription (cloud STT) | Working pipeline, blocked on user key | Working pipeline | Needs a Groq/OpenAI key; provider 401 surfaces verbatim |
| Local transcription (whisper.cpp) | Not integrated | Planned (Phase 1) | whisper-cli.exe + ggml-tiny.bin verified present on this machine |
| AI interview answers | Working | Working | Phase 3 adds story-bank grounding |
| Career profile + fact CRUD | Multiple profiles, facts | Working | Confirmation workflow planned (Phase 2) |
| Résumé import | PDF/TXT/MD | PDF/TXT/MD | DOCX planned (Phase 2) |
| Career Story Bank | Missing | Planned (Phase 2) | — |
| Live translation | Missing | Planned (Phase 4) | — |
| Screen intelligence (question, coding, documents) | Working | Working | Vision provider required |
| Screen translation | Missing | Planned (Phase 4) | — |
| Private overlay | Deliberately excluded | **Implemented + verified** | `docs/overlay-capture-exclusion.md` |
| Capture exclusion | Deliberately excluded | **Implemented + verified** (overlay only) | 8.21% → 0% magenta share |
| Meeting intelligence | Working (summary, actions, search, export) | Working | Transcripts isolated per session |
| Practice interviews | Working (7 types, scorecards) | Working | `docs/transformation-report.md` |
| AI chat with context | Working | Working | Profile/story/meeting context selectable |
| Phone companion | Missing | **Blocked** | Needs a mobile client + pairing backend; no toolchain here. Desktop-side pairing contract is documented, not faked. |
| Accounts / cloud sync | Missing | **Blocked** | Needs a server and credentials; local-first behaviour is unchanged |
| Subscriptions / payments | Missing | **Blocked** | No payment provider configured; never simulated |
| Usage dashboard | Missing | Partial — local token/latency figures exist per answer | No billing backend to aggregate against |
| Windows packaging | NSIS installer verified at 0.2.1 | Rebuilt and launch-verified | `dist/` |

## Deliberate non-features

- No automatic typing into other applications.
- No stealth recording, no proctoring evasion.
- No simulated payments, subscriptions, or sync success.

## Verification commands

```powershell
npm test                 # vitest (300 tests after Phase 6)
npm run typecheck
npm run build
$env:COPILOT_SELFTEST='overlay';        .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='overlay-window'; .\node_modules\electron\dist\electron.exe .
```
