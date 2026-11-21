# Screen translation — OCR + language engine (0.4.0)

Status: **implemented and verified end to end on this machine**, with no cloud key.
Last verified: 2026-11-21.

## Flow

```
consent-gated capture (existing ScreenService backend)
  → optional normalized region crop
  → LOCAL OCR (Windows.Media.Ocr via PowerShell/WinRT)
  → language label (script detection, display only)
  → translation engine (active provider, 49 targets)
  → result: original + translated + both providers named
```

OCR and translation are separate services on purpose:

| Step | Provider | Failure behaviour |
|---|---|---|
| Capture | Electron `desktopCapturer` | "Could not capture the screen: …" |
| OCR | Windows OCR (local, no key) | "No readable text…" / engine error |
| Translation | Active provider (local or cloud) | Recognised text is **kept**, result marked `partial` |

So a provider outage never destroys the text you already captured, and nothing is reported as
translated unless a translation actually came back.

## Measured result

`COPILOT_SELFTEST=screentranslate` renders two English lines in a window, captures it, OCRs it and
translates to Spanish with Ollama `qwen2.5:1.5b`:

```json
{"windowCaptureAvailable":true,"elapsedMs":6268,"ok":true,
 "original":"Good morning. The meeting starts at nine. Please review the quarterly numbers.",
 "translated":"Buenos días. La reunión comienza a las nueve. Por favor, revise los números cuatrimestrales.",
 "ocrProvider":"Windows OCR","translateProvider":"Ollama (self-test)",
 "ocrLanguage":"en-US","detectedLanguage":"Latin",
 "recognisedEnglish":true,"translatedNonEmpty":true,"historyCount":1,
 "blankOk":false,"blankMessage":"No readable text was found in that region. Try a larger area."}
```

The OCR text matched the rendered text exactly, and the blank-region case correctly refused to
report a translation.

Reproduce:

```powershell
$env:COPILOT_SELFTEST='screentranslate'; .\node_modules\electron\dist\electron.exe .
```

## In the app

**Read screen** → pick a source → optionally drag a region on the preview → choose a target
language → **Translate selection**. The result shows the recognised text, the translation, the OCR
provider, the translation provider and the detected script, with *copy translation*, *copy
original* and *send to overlay*.

History: the last 20 translations are kept in memory for the session (not written to disk, matching
the app's transcript policy). `clearScreenTranslations` empties it.

## OCR limits (important)

- **Only installed Windows OCR languages are recognised.** On this machine that is `en-US` only.
  Other languages need the corresponding Windows language pack; until then, non-English screens
  produce little or no text.
- Tiny text, low contrast, unusual fonts and heavy styling reduce accuracy.
- The engine returns text, not layout: columns and tables are flattened.
- If OCR is insufficient for a screen (complex diagrams, handwriting), a vision-capable provider is
  the right tool — that path exists in Screen analysis, but no vision model is configured here.

## Not verified

- Non-English OCR (no language pack installed).
- Translation of non-Latin OCR output.
- Live/continuous translation of a changing region ("where technically practical"): not
  implemented; each translation is one explicit capture.
