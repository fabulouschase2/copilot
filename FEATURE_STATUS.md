# FEATURE STATUS

Honest, code-level status. "Verified" means it was exercised on this machine and the
evidence is recorded; "implemented" means the code exists and is unit-tested but was
not driven end-to-end with real credentials or hardware.

Last updated: 2026-11-21 (after Phase 6).

| Area | Before this work | Now | Evidence / gap |
|---|---|---|---|
| Live audio capture (mic + Windows loopback) | Working | Working | `docs/full-functionality-audit.md`; audio pipeline tests |
| Live transcription (cloud STT) | Working pipeline, blocked on user key | Working pipeline | Needs a Groq/OpenAI key; provider 401 surfaces verbatim |
| Local transcription (whisper.cpp) | Not integrated | **Implemented + verified** — managed server | `docs/local-whisper.md`: 11 s audio → 0.53 s, `/inference` contract |
| AI interview answers | Working | Working | Phase 3 adds story-bank grounding |
| Career profile + fact CRUD | Multiple profiles, facts | **Working with verification** — pending/confirmed/rejected, source quotes, inline edit | Schema v5; `docs/resume-facts.md` |
| Résumé import | PDF/TXT/MD | **PDF / DOCX / TXT / MD** | DOCX via dependency-free ZIP+XML; scanned PDFs need OCR (not implemented) |
| Career Story Bank | Missing | **Implemented + verified** — 5 frameworks, ranking, grounded drafts | `docs/career-story-bank.md`; schema v4 |
| Live translation | Missing | **Implemented + verified** (local model) | `docs/live-translation.md`: EN→ES 3.7 s, live event pipeline |
| Screen intelligence (question, coding, documents) | Working | Working | Vision provider required |
| Screen translation | Missing | Partial — the language engine translates text, but there is no screen-region translate action yet | Phase 5 remaining |
| Private overlay | Deliberately excluded | **Implemented + verified** | Display capture/GDI/PrintWindow exclude it; window-source capture does not (documented) |
| Capture exclusion | Deliberately excluded | **Implemented + verified** (overlay only) | 8.21% → 0% magenta share |
| Meeting intelligence | Working (summary, actions, search, export) | Working | Transcripts isolated per session |
| Practice interviews | Working (7 types, scorecards) | Working | `docs/transformation-report.md` |
| AI chat with context | Working | Working | Profile/story/meeting context selectable |
| Phone companion | Missing | **Blocked** | Needs a mobile client + pairing backend; no toolchain here. Desktop-side pairing contract is documented, not faked. |
| Accounts / cloud sync | Missing | **Blocked** | Needs a server and credentials; local-first behaviour is unchanged |
| Subscriptions / payments | Missing | **Blocked** | No payment provider configured; never simulated |
| Usage dashboard | Missing | Partial — local token/latency figures exist per answer | No billing backend to aggregate against |
| Windows packaging | NSIS installer verified at 0.2.1 | **Rebuilt and verified** — `dist/Copilot-Setup-0.3.0.exe`; capture exclusion re-tested in the packaged app | Unsigned (no certificate) |

## Deliberate non-features

- No automatic typing into other applications.
- No stealth recording, no proctoring evasion.
- No simulated payments, subscriptions, or sync success.

## Verification commands

```powershell
npm test                 # vitest (374 tests after Phase 2 completion)
npm run typecheck
npm run build
$env:COPILOT_SELFTEST='overlay';        .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='overlay-window'; .\node_modules\electron\dist\electron.exe .
```
