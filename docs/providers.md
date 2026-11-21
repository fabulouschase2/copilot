# Providers: Gemini, Ollama, switching and local-only mode

Status: **configuration and failure paths verified; a real Gemini generation was not run**
(no API key is present on this machine). Last verified: 2026-11-21.

## Gemini configuration

Settings → Providers → add/edit the Gemini row:

| Field | Value |
|---|---|
| Base URL | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Model | `gemini-2.0-flash` (or any model your key can access) |
| API key | from Google AI Studio, entered in the app |
| Vision | tick if the model accepts images |

Gemini is used through its **OpenAI-compatible** surface, so it flows through the same adapter,
streaming, cancellation and error mapping as every other provider. The model name is configurable;
nothing is hardcoded, and the key is never written to source, logs or the renderer.

**To finish this task you must add your key in the app** (Settings → Providers → Save key). The
app then stores it OS-encrypted (DPAPI) and decrypts it only in the main process at request time.

## What was verified without a key

`COPILOT_SELFTEST=providers`:

```json
{"geminiTestOk":false,"geminiTestMessage":"Provider responded with HTTP 400",
 "geminiMessageLeaksKey":false,
 "geminiChatError":"Provider rejected the request (400)","geminiChatLeaksKey":false,
 "unreachableOk":false,"unreachableMessage":"Could not reach provider: fetch failed",
 "ollamaOk":true,"ollamaLatencyMs":13,
 "switchFirst":"Google Gemini","switchSecond":"Ollama","switchWorks":true,
 "localOnlyResolvesWithoutKey":true,
 "credentialSaved":true,"credentialFileContainsPlaintext":false}
```

Read:

- An invalid key produces an honest HTTP error; **the key never appears in any message**.
- An unreachable endpoint fails cleanly instead of hanging or crashing.
- Ollama connects with no key in 13 ms (local-only mode works).
- Switching the active provider is applied on the next resolution — no restart.
- The credential store round-trips the secret and the on-disk file **does not contain it in clear**.

Note: Gemini answers `400` (not `401`) for an unusable key on the `/models` probe. The UI shows the
provider's status verbatim rather than guessing a cause.

## Ollama

`http://127.0.0.1:11434/v1`, no key. Verified live with `qwen2.5:1.5b` for translation, story
drafting and résumé fact extraction.

## Not verified

- A successful Gemini generation (needs the key).
- Gemini vision/screen analysis (needs a key and a vision-capable model).
- Rate-limit behaviour (429) against the real Gemini endpoint.
