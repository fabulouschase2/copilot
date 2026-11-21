# Live translation — Phase 4

Status: **implemented and verified with a real model** (local Ollama, no API key).
Last verified: 2026-11-21.

## What it does

1. A `translation`-purpose capture session records mic or system audio (the same verified capture
   path used by interview and meeting sessions).
2. Each finalized utterance from the STT provider becomes one translation request on the active
   chat provider.
3. The panel shows the recognized line (optional) above its translation, and names the provider
   that produced each line.
4. Translated lines are mirrored to the private overlay, so captions can be read while sharing
   something else.

Translation is an independent engine: it never runs through the interview answer generator, never
uses interview prompts, and stopping one workflow does not affect the other.

## Measured result (real, local model)

`COPILOT_SELFTEST=translation` with Ollama `qwen2.5:1.5b` at `http://127.0.0.1:11434/v1`:

```json
{"baseUrl":"http://127.0.0.1:11434/v1","model":"qwen2.5:1.5b","ok":true,
 "translated":"Buen día. Fui el líder de un equipo de cuatro ingenieros y reduje los tiempos de construcción en un 40 por ciento.",
 "providerLabel":"Ollama (self-test)","latencyMs":3682,
 "liveEventCount":1,
 "liveEvents":[{"kind":"result","text":"Deberías ser conciso en tu respuesta.","provider":"Ollama (self-test)"}],
 "stats":{"queued":0,"dropped":0,"translated":1,"failed":0}}
```

Two properties are demonstrated: the direct translation path, and the live pipeline
(`observeSegment` → exactly one `translation:result` event carrying original, translation,
target language and provider label).

Reproduce:

```powershell
$env:COPILOT_SELFTEST='translation'; .\node_modules\electron\dist\electron.exe .
# optional overrides:
$env:COPILOT_TRANSLATE_BASEURL='http://127.0.0.1:11434/v1'
$env:COPILOT_TRANSLATE_MODEL='qwen2.5:1.5b'
```

## Design decisions

| Decision | Why |
|---|---|
| Serial queue, backlog capped at 4 | Captions must stay live; translating minutes-old lines is worse than dropping them, and drops are counted |
| Provider named per line | The user must know whether a cloud model or the 1.5B local model produced the text |
| Prompt forbids commentary and answers | Small models otherwise explain the sentence instead of translating it |
| Mechanical wrappers stripped only | `Translation:` prefixes and wrapping quotes are removed; content is never rewritten |
| Empty output = failure | A blank caption would look like a successful silent translation |
| Session history in memory only | Consistent with the app's no-transcript-on-disk policy |

## Language coverage (honest)

The UI offers **49 languages**. That is the list of selectable targets, not a quality guarantee.

- Large cloud models (Gemini, GPT-class) handle all of them reasonably.
- `qwen2.5:1.5b` is good for English ↔ major European/Asian languages and weaker elsewhere.
- The engine always shows which provider produced the line, so quality is attributable.

## Not verified

- **Cloud providers** were not exercised: no Gemini/OpenAI key is configured on this machine.
- **Non-English source audio** was not transcribed/translated in a real session.
- **A real microphone session** was not run end-to-end for translation; the capture path itself is
  the one verified in earlier phases, and the translation pipeline was exercised with real
  segments and a real model.
- **Mixed-language utterances** are handled as "auto" detection by the STT provider, but no
  mixed-language sample was tested.

## Requirements

- A configured chat provider (cloud or local). Translation uses the active provider.
- A configured STT provider (cloud or the managed local Whisper from Phase 1).
- Microphone or system-audio access, granted per session.
