# Pull request — Copilot 0.3.1 development phase

**Branch:** `feature/klevi-level-transformation` → `master` (not merged; awaiting your approval)
**Compare:** https://github.com/fabulouschase2/copilot/compare/master...feature/klevi-level-transformation

## What this branch contains

### 1. Privacy verification — and a real defect fixed

The overlay window was created with `transparent: true` while the app disables hardware
acceleration. Windows never composited it: `isVisible()` returned `true` but **zero pixels were
painted**, so the overlay was invisible. Found by measuring screen pixels, not by trusting the API.

Fixed (opaque window, same card styling), then measured with a real overlay painted magenta and an
opaque control window as the baseline (74.1% coverage — proving the capture paths work):

| Capture path | Exclusion off | Exclusion on |
|---|---|---|
| Chromium display capture (entire-screen sharing) | 17.7% | **0%** |
| GDI `BitBlt` (legacy recorders) | 14.8% | **0%** |
| GDI of the overlay rectangle | 15.0% | **0%** |
| `PrintWindow` | 96.8% | **0%** |
| Chromium window-source capture | 98.6% | **98.4% — not hidden** |

The last row is a documented limitation: do not rely on exclusion when sharing *that specific
window*. OBS is not installed here and Google Meet needs a second participant, so those two remain
explicitly unverified.

### 2. Career profile completed

- **DOCX import** with no new dependency (ZIP central directory → `word/document.xml` → text).
- **Schema v5** fact lifecycle: `pending` / `confirmed` / `rejected`, with `source_text` and
  `source_document_id`. Existing facts migrate as confirmed.
- **Quote-anchored extraction**: a model-proposed fact is stored only when its quote appears
  verbatim in the document. Measured with Ollama: 2 facts, `quotesAnchored: true`, pending facts
  excluded from retrieval, confirmed facts included.
- Settings UI: confirm / reject / edit / restore with the supporting quote; per-document
  "Extract facts".
- Retrieval, practice and story drafts use confirmed facts only.
- Migration robustness: table creation is idempotent and independent of the version marker.

### 3. Provider verification (Gemini key still required)

`COPILOT_SELFTEST=providers` proves: invalid key → honest 400 with **no key leakage**; unreachable
endpoint → clean failure; Ollama → 13 ms with no key (local-only); provider switching applies
immediately; the credential file contains no plaintext secret.

**Action needed from you:** enter the Gemini key in Settings → Providers, then run a generation and
a vision pass. Nothing else is blocked on it.

### 4. Shared context

Practice question generation now also receives a digest of saved career stories, so mock interviews
target real experience. Interview answers already receive the top-ranked stories; meetings are
deliberately excluded.

### 5. Test count reconciled

README, TESTING and FEATURE_STATUS now state the real numbers: **374 tests / 44 files**
(previously 282, then 353).

## Verification summary

| Check | Result |
|---|---|
| `npm test` | **374 / 374 passed**, 44 files |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `COPILOT_SELFTEST=career` | facts extracted, quotes anchored, pending hidden |
| `COPILOT_SELFTEST=privacy` | 4 paths measured (table above) |
| `COPILOT_SELFTEST=providers` | no key leakage, switching works, local-only works |
| `COPILOT_SELFTEST=ui` | 7 views + Settings render, zero console errors |
| Packaged app | `dist/Copilot-Setup-0.3.1` build path verified previously at 0.3.0; native binding survives asar |

## Not done in this pass (explicit)

- **Screen translation (Task 3)**: not implemented. It needs a vision-capable provider for OCR,
  which is not configured here; shipping an unverifiable OCR path would violate the "no placeholder"
  rule. The region-selection and capture machinery it would reuse already exists.
- **OBS / Google Meet** capture behaviour: unverified for the reasons above.
- **Real Gemini generation / vision**: needs your key.
- **Linting**: this repository has no linter configured; `tsc` is the static gate. Adding ESLint is
  a separate decision (it would require a large one-off cleanup).
- Signed installer (no certificate), installer uninstall/reinstall cycle.

## Review notes

- `master` was never modified; no force-push was used.
- Every phase is a separate commit with its measurement in the message.
- Evidence files: `docs/overlay-capture-exclusion.md`, `docs/resume-facts.md`,
  `docs/career-story-bank.md`, `docs/live-translation.md`, `docs/local-whisper.md`,
  `docs/providers.md`, `PROGRESS.md`, `FEATURE_STATUS.md`, `TESTING.md`.
