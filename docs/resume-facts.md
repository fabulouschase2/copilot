# Career profile: résumé import and verified facts (Phase 2 completion)

Status: **implemented and verified** with a real model.
Last verified: 2026-11-21. Schema v5.

## Résumé import

| Format | How | Notes |
|---|---|---|
| TXT / MD | direct text | existing |
| PDF | `pdf-parse` (pure JS) | existing; text-based PDFs only |
| **DOCX** | **new, dependency-free** | ZIP central directory → inflate `word/document.xml` → WordprocessingML to text |

The DOCX path adds no dependency. It reads the archive's central directory, inflates only the
document body, and converts paragraphs, line breaks, tabs and table cells to text. It fails with a
specific message instead of producing garbage:

- `.doc` renamed to `.docx` → "Not a valid .docx archive…"
- archive without `word/document.xml` → explicit message
- encrypted/unsupported compression → explicit message
- >10 MB or >200k extracted chars → bounded

## Fact lifecycle

Every fact now has a state and, when extracted, provenance:

```
pending   → extracted by the model, waiting for the user
confirmed → the user accepted it; it is "verified experience" and may reach a model
rejected  → the user declined it; kept for audit, never retrieved
```

Facts the user types themselves are created as `confirmed`. Facts extracted from a document are
created as `pending`, with:

- `source_text` — the verbatim phrase that supports the fact
- `source_document_id` — which document it came from

## The anti-fabrication gate (the important part)

The model proposes JSON; the app decides. A proposed fact is stored **only if its `sourceText`
appears verbatim in the imported document** (whitespace-normalized, case-insensitive). Everything
else is rejected with a reason and shown to the user:

| Rejection | Meaning |
|---|---|
| "Supporting quote does not appear in the document" | the model paraphrased or invented it |
| "Supporting quote was missing or the wrong length" | no usable evidence |
| "Unknown category" | outside the schema |
| "Duplicate fact" | near-identical to one already accepted |

So a small local model that embellishes cannot turn "led a team of four" into "led a team of
twenty" and have it survive.

## Measured end-to-end result

`COPILOT_SELFTEST=career` with Ollama `qwen2.5:1.5b` on a five-line résumé:

```json
{"provider":"Ollama (self-test)","model":"qwen2.5:1.5b","ok":true,
 "added":2,"rejected":0,"elapsedMs":15080,
 "stored":2,"allPending":true,"quotesAnchored":true,
 "confirmedVisible":true,"pendingHidden":true}
```

Read: extraction produced 2 facts, both stored as pending, and **every** stored quote was found in
the document. After confirming one fact, retrieval returned it and kept the other (pending) fact
out of the prompt.

## Retrieval rules

- `ContextService.retrieve` includes only `confirmed` facts — pending and rejected never reach a
  prompt.
- Career-story drafts and practice interviews use confirmed facts only.
- The UI shows pending facts first with Confirm / Reject, and the source quote under each fact.

## Migration

Schema v5 adds `status`, `source_text`, `source_document_id` to `profile_facts`. Existing facts
default to `confirmed` (they were user-authored), so no behaviour changes for existing users.

Also fixed in this phase: table creation is now **idempotent and independent of the version
marker**, so a database whose marker is ahead of its actual tables (partial restore, hand-edited
file) starts instead of failing on first query.

## Not verified / limits

- **Scanned PDFs** need OCR; there is no OCR adapter, so image-only PDFs yield little or no text.
- Legacy `.doc` and encrypted documents are rejected by design.
- Extraction quality depends on the provider: the 1.5B local model is conservative (2 facts from
  5 lines); larger cloud models extract more.
- DOCX extraction was unit-tested with generated archives; no real-world Word file was imported.
