# Feature Comparison Matrix

*Columns: Feature | Poisely | Nutshell/Tails | NoteMotion AI | Ours (build status) | Evidence | Build priority*

Classification legend: **C** = Confirmed, **P** = Partially confirmed, **U** = Unverified, **N** = Not available. "Ours" reflects implementation status as of Stage 3–4; see `STAGES.md` for the live checklist.

| Feature | Poisely | Nutshell (Tails) | NoteMotion AI | Ours | Evidence | Build priority |
|---|---|---|---|---|---|---|
| System-audio listening (no bot) | C | C | C | planned (Stage 5) | P1,P2,P3 | High |
| Microphone capture | U | U | U | planned (Stage 5) | — | High |
| Live transcription, partial+final | C | C | C | planned (Stage 5) | P1,P2,P3 | High |
| Speaker attribution | U | P | C | planned | P3,P5 | Medium |
| Timestamps / segmentation | C | C | C | planned | P1,P2,P3 | High |
| Real-time interview answers | C | N | U¹ | partial (mode designed) | P1 | High² |
| Behavioral / STAR preparation | C | N | N | planned (Stage 8) | P1 | High² |
| Coding-problem analysis | C | N | N | planned (Stage 8) | P1 | Medium |
| Aptitude-test solving | C | N | N | excluded³ | P1 | Excluded |
| Screen reading / OCR of on-screen text | C | N | C | planned (Stage 6) | P1,P3 | High |
| Region/window screenshot capture | U | N | U | planned (Stage 6) | P1 | High |
| Vision-model analysis of screenshots | U | N | U | planned (Stage 6) | P1 | High |
| Capture-excluded / invisible overlay | C | N | C⁴ | **excluded by design**³ | P1,P3 + binary | Excluded |
| Autotyper (types answers into fields) | N | N | C | **excluded by design**³ | P3 | Excluded |
| Meeting summaries + action items | C | C | C | planned (Stage 8) | P1,P2,P3 | High |
| Searchable conversation history | C | C | C | planned (Stage 9) | P1,P2,P3 | Medium |
| Transcript export (MD/TXT/JSON) | U | C (Obsidian) | C | planned (Stage 8) | P2,P3 | Medium |
| Resume / JD / doc context | C | P | C | planned (Stage 9) | P1,P3 | High |
| Mock interviews + scorecards | C | N | N | planned (Stage 8) | P1 | Medium |
| On-device / local processing | N | C | U | planned (local models via adapter) | P2 | High |
| **Multi-provider AI (BYO API keys)** | N | N | N | **implemented (Stage 4)** | none document it | **High — differentiator** |
| **Local model endpoints (Ollama/LM Studio)** | N | N | N | **implemented (Stage 4)** | none document it | **High — differentiator** |
| **Hot provider switching, no restart** | N | N | N | **implemented (Stage 4)** | none document it | **High — differentiator** |
| Provider latency/failure metrics | N | N | N | implemented (test/latency) | — | Medium |
| Floating + resizable copilot window | C | C | C | implemented (Stage 3) | P1,P2,P3 | High |
| Global shortcut to summon window | C | U | U | implemented (Ctrl+Alt+C) | P1 | Medium |
| Dark/light themes | U | U | U | implemented (Stage 3) | — | Medium |
| Recording/permission indicators | U | C (consent alert) | U | partial (status strip) | P2 | High |
| Windows support | C | N | C | **implemented (Windows-first)** | P1,P2,P3 | High |
| macOS support | C | C | N | not yet | P1,P2 | Later |
| Linux support | N | N | N | not yet | — | Later |

¹ NoteMotion never uses the word "interview," but its copilot + overlay + autotyper combination is functionally equivalent; classification U pending product behavior.
² Interview features are built for **preparation, practice, and user-visible assistance** only; no stealth, no capture evasion, no answer autotyping into live assessments (spec §8, §10).
³ Excluded per project spec §10/§13 (no concealment to evade supervision, no bypassing security controls). Documented as competitor features for research completeness only.
⁴ NoteMotion's own docs hedge: "cannot guarantee exclusion from every recorder."

## Deliberate exclusions (with rationale)

| Competitor feature | Why excluded |
|---|---|
| Screen-capture-invisible overlay (Poisely, NoteMotion) | Spec §10: "Do not implement stealth recording, concealment intended to evade supervision, or mechanisms that bypass another application's security controls." |
| Humanised Autotyper (NoteMotion) | Automating answer delivery into third-party controlled fields is assessment-evasion; spec §8: "do not build covert recording or assessment-evasion mechanisms." |
| "Undetectable" marketing claims (Poisely) | We make no undetectability claims; the visible window + recording indicators are the product. |
