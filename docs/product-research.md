# Product Research — Poisely, Nutshell (Tails), NoteMotion AI

*Phase Zero deliverable. Researched 2026-10-24. All claims carry a classification and a source; see `feature-evidence.md` for the full evidence trail.*

## 1. Poisely

**Identity: CONFIRMED.** Official site is **https://poisely.co** (poisely.com is parked/for sale; poisely.ai does not resolve). Tagline: "your AI for every conversation." The official docs name the Windows installer `Poisely-Setup.exe`, which matches the supplied installer byte-for-byte in naming and version range (v1.2.2, NSIS, ~97 MB, signed CN=Ismail Oganla, Abuja, NG).

**Category:** Real-time AI interview/meeting copilot (desktop app + browser mock-interview practice). Captures **system audio** (no bot joins the call), streams suggested answers in <1 s in 50+ languages, renders them in an always-on-top window that is **excluded from screen capture by the OS** (its own installer metadata: "Poisely overlay that stays invisible to screen capture").

**Confirmed features** (official site/docs):
- Real-time interview answers (<1 s): research-persona, behavioral (STAR), and live-coding modes
- "Read screen": reads coding problems and aptitude-test questions from the page (Max plan)
- Aptitude-test solving (numerical/verbal reasoning, sequences, analogies, logic)
- Meeting mode: live transcript, instant summary, action items, no participant bot
- "Ask your calls": query saved meeting transcripts (Max)
- Free browser mock interviews with scorecards (/100 + per-competency)
- Context files: résumé (PDF/DOCX/text), job description, case studies
- Phone pairing as a second display (Max)
- Capture-excluded overlay; F8 toggle; Ctrl+Shift+Q quit
- Docs explicitly warn it will not work in proctored/lockdown environments

**OS:** Windows 10 (2004+), macOS 13+ (Apple Silicon + Intel builds). No Linux.
**Pricing:** free 5-min live trial + unlimited browser mocks; $5/interview (24 h pass); Pro $20/mo; Max $40/mo. Card or crypto. **No API keys, no provider selection documented** (closed consumer app).
**Unverified without account:** answer quality/latency in practice, scorecard behavior, capture-exclusion reliability across recorders, phone-pairing reliability. No independent reviews found.

## 2. Nutshell (the AI copilot product)

**Identity: AMBIGUOUS NAME, RESOLVED.** Three distinct "Nutshell"s exist:
1. **Nutshell CRM** (nutshell.com) — AI sales CRM for small business. **Not** the copilot.
2. **The AI desktop copilot the user means: withnutshell.com** — an unrelated company whose desktop app was **formerly named "Nutshell" and is now branded "Tails"** (their own help page: "Uninstall Tails (Formely Nutshell)"). macOS installer ships from an S3 bucket named `NutshellElectron`.
3. Smikar's "Nutshell AI" for SharePoint — unrelated.

**Category:** On-device AI meeting assistant: "Get meeting summaries without data leaving your device. No WiFi required. No bots sent to your meetings." System-audio capture, real-time local transcription, all processing local.

**Confirmed features** (official site/help):
- Real-time transcription + batch processing
- Interactive AI chatbot over meetings; customizable prompts
- Fully offline / on-device ("No audio, transcriptions, or chat data ever leaves your computer")
- Recording + replay; folders/labels; Obsidian export; 100+ languages claimed
- Meeting-app integrations documented (Zoom, Chime, Meet, Slack Huddle)
- **Built-in consent alert** when live transcription starts ("remind all participants")

**OS:** macOS only, Apple Silicon M1+, macOS 13+, 16 GB RAM for AI features. **No Windows build documented** — a direct gap our Windows-first build fills.
**Pricing:** free tier (10-min transcriptions, local), Pro $9/mo (unlimited, commercial license), license-key model, bulk keys for teams. **No API keys / provider selection documented.**
**Unverified:** transcription accuracy, 100+ language claim, roadmap (Canny link unread); their own FAQ is marked "under development."

## 3. Notemotion.ai

**Identity: CONFIRMED as "NoteMotion AI"** at **https://notemotion.ai** (notemotion.com and note-motion.ai do not exist). Distributed as a bare GitHub-release binary (v0.1.18 x64) from org `NoteflowAInotion`; no company disclosure. Early-stage, single-maintainer profile.

**Category:** "Private real-time AI meeting copilot for Windows": listens, transcribes, "drafts the next line inside a private overlay" built to "stay off supported screen-share" using Windows display-affinity, with the honest caveat "cannot guarantee exclusion from every recorder."

**Confirmed features** (official site):
- Live speaker-aware transcription
- Overlay via display-affinity (hedged claims)
- "Humanised Autotyper": types a prepared answer into the focused field with countdown and human-like pacing
- AI meeting copilot (ask questions, summarize)
- Context prep: meeting brief + up to 5 documents
- Notes, decisions, action items, follow-up email, searchable history

**OS:** Windows 10/11 only. Tested with Zoom/Teams/Meet.
**Pricing:** free trial (3 meetings × 10 min, 7-day history); $15 copilot pass / 30 days (no subscription); credit packs $9–$40 (1 credit = 1 min transcription). Provider selection not documented ("a configured speech-to-text service" is referenced).
**Unverified:** overlay effectiveness per app/recorder, autotyper behavior, STT provider identity, deletion behavior.

## Cross-cutting findings

- **None of the three documents multi-provider AI, API keys, or local-model support.** Tails is the only on-device product; its model is fixed. This is the differentiation our build targets (per user requirement: multi-provider, API keys, local models, instant switching).
- **Capture-evasion positioning diverges:** Poisely markets "undetectable" + OS-level capture exclusion; NoteMotion hedges; Tails takes the opposite stance (on-device privacy + consent alert). Our build follows the Tails end of the spectrum plus the project spec's own prohibitions (§10, §13): visible window by default, no capture-evasion, no autotyper, no stealth recording.
- **Platform gaps:** Tails is macOS-only; NoteMotion is Windows-only; Poisely covers both but is closed and cloud-bound. A Windows-first, provider-open build with macOS portability is unoccupied territory.
- **Pricing signals:** all three monetize per-minute/per-interview or subscription; none expose BYO-key economics, which materially lowers user cost for our product.
