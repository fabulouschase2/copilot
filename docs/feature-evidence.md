# Feature Evidence Ledger

*Every material claim from the research docs, with its evidence type and source. Evidence types: **[web-fetched]** = page fully retrieved and read by the research pass; **[search-snippet]** = seen only in search results (weaker); **[binary-static]** = observation from REA static analysis of the supplied installer, Evidence IDs cited.*

## A. Binary evidence — Poisely-Setup.exe (REA static analysis, 2026-10-24)

| # | Observation | Evidence ID / method |
|---|---|---|
| B1 | File: `C:\Users\Lenovo\Downloads\Poisely-Setup.exe`, SHA-256 `9cc008b06cc922ba88be9c8e7c8bd9cc36d8ca86836a2822ae0dc9e666cb9cd9`, PE x86, 102,004,856 bytes (~97 MiB) | `open_binary` result (ev session closed) |
| B2 | Valid Authenticode signature: `CN=Ismail Oganla, O=Ismail Oganla, L=Abuja, S=Federal Capital Territory, C=NG` | PowerShell `Get-AuthenticodeSignature` — Status: Valid |
| B3 | VersionInfo: ProductName/CompanyName "Poisely", version 1.2.2 | PowerShell `VersionInfo` |
| B4 | **FileDescription: "Poisely overlay that stays invisible to screen capture"** — the vendor's own metadata declares capture-evasion as a core capability | PowerShell `VersionInfo` |
| B5 | Packaging: NSIS installer ("NullsoftInst" magic present at offset; ~97 MB size consistent with Electron-bundler NSIS; Electron *presumed, unverified* — payload is LZMA-compressed, no readable Electron markers) | `grep -aboc NullsoftInst` |
| B6 | REA generic inventory found no decomposable child container; PE has no NSIS extraction reader in REA | `inspect_artifact` (ev_a0e75b6f…) + `extract_artifact` error |
| B7 | Official docs naming `Poisely-Setup.exe` confirm provenance of this installer | [web-fetched] poisely.co/docs |

**Limits of binary evidence:** no runtime behavior observed; the app was not installed or executed. All Poisely *behavioral* claims come from its own website/docs.

## B. Web evidence — Poisely ([web-fetched] unless noted)

| # | Claim | Source |
|---|---|---|
| W1 | Official domain poisely.co; tagline "your AI for every conversation"; system-audio capture; <1 s answers; 50+ languages; capture-excluded overlay | https://poisely.co |
| W2 | Docs: installer name, Win10 2004+/macOS 13+, F8 hide toggle, Ctrl+Shift+Q quit, résumé/JD uploads, phone pairing, "unsupported languages are transcribed wrongly rather than not at all", proctored-environment warning | https://poisely.co/docs |
| W3 | Pricing: free 5-min trial + browser mocks; $5/interview; Pro $20/mo; Max $40/mo; crypto accepted | https://poisely.co + /docs |
| W4 | Modes: research-persona, behavioral STAR, live coding; "Read screen" (Max); aptitude solving; "Ask your calls" | https://poisely.co, /docs |
| W5 | poisely.com 301-redirects to brandsly.com (parked); poisely.ai NXDOMAIN | fetch observation |
| W6 | No provider/API-key configuration documented anywhere | https://poisely.co, /docs |
| W7 | No independent reviews found; "Poised" (poised.com) is a different product | [search-snippet] |

## C. Web evidence — Nutshell / Tails

| # | Claim | Source |
|---|---|---|
| W8 | Nutshell CRM (nutshell.com) is a separate AI sales CRM — not the copilot | https://www.nutshell.com |
| W9 | withnutshell.com desktop app **formerly named "Nutshell", now "Tails"** (help page title "Uninstall Tails (Formely Nutshell)"); S3 bucket `NutshellElectron` | https://help.withnutshell.com/uninstall/uninstall-overview.md ; https://withnutshell.com |
| W10 | On-device pitch: "without data leaving your device… No bots sent to your meetings"; "All processing happens locally… works perfectly without an internet connection" | https://withnutshell.com ; help FAQ |
| W11 | Features: real-time + batch transcription, AI chatbot, custom prompts, recording/replay, folders/labels, Obsidian export, 100+ languages, Zoom/Chime/Meet/Slack integration docs | https://help.withnutshell.com/getting-started/introduction ; /llms.txt |
| W12 | macOS-only: M1+, macOS 13+, 16 GB RAM for AI features; no Windows build documented | https://help.withnutshell.com/getting-started/download-and-install.md ; FAQ |
| W13 | Pricing: free tier (10-min limit), Pro $9/mo, license keys, bulk/enterprise keys | https://withnutshell.com ; FAQ |
| W14 | Built-in consent alert when live transcription starts | https://help.withnutshell.com/getting-started/introduction |
| W15 | FAQ page flagged by vendor as "under development… may contain incomplete or inaccurate information" | https://help.withnutshell.com/getting-started/FAQ.md |
| W16 | Smikar "Nutshell AI" (SharePoint) is a third unrelated product | [search-snippet] smikar.com/nutshell-ai |

## D. Web evidence — NoteMotion AI

| # | Claim | Source |
|---|---|---|
| W17 | Official domain notemotion.ai; "NoteMotion AI" spelling; notemotion.com / note-motion.ai NXDOMAIN | fetch observations |
| W18 | Windows 10/11 only; v0.1.18 x64 via GitHub releases (org `NoteflowAInotion`); no company disclosure | https://notemotion.ai ; https://github.com/NoteflowAInotion |
| W19 | Overlay via "supported Windows display-affinity controls to stay out of common screen-share and recording paths" with caveat "cannot guarantee exclusion from every recorder" | https://notemotion.ai |
| W20 | "Humanised Autotyper" — types prepared answers into the focused field with countdown/pacing | https://notemotion.ai |
| W21 | Live speaker-aware transcription; meeting copilot; meeting brief + up to 5 documents; notes/decisions/action items/follow-up email; searchable history | https://notemotion.ai |
| W22 | Pricing: free trial 3×10 min; $15/30-day copilot pass; credit packs $9–$40 (1 credit = 1 min) | https://notemotion.ai |
| W23 | Never markets "interview" use; tested with Zoom/Teams/Meet | https://notemotion.ai |

## E. Evidence gaps (what remains unverified)

- All three products: runtime behavior, latency, and accuracy claims are vendor-stated only. Nothing was executed.
- Poisely capture-exclusion and NoteMotion display-affinity effectiveness vary by recorder and are explicitly hedged by NoteMotion; **we did not and will not test evasion behavior.**
- Tails roadmap/Windows plans: Canny board not read ([search-snippet] only).
- NoteMotion changelog/privacy/terms subpages exist but were not individually fetched.
- Electron packaging of Poisely: presumed from size + NSIS + electron-builder conventions; payload compressed, so unverified.

*Ledger rule: any future doc citing a competitor feature must cite a row here. Rows are append-only; corrections add a new row rather than editing.*
