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

- Rate-limit behaviour beyond the observed 429s (no long soak test).
- Gemini streaming cancellation under load.

## Live verification (0.5.0, real key)

`COPILOT_SELFTEST=gemini-live` with the key supplied out-of-band (environment variable, never
source or argv):

```json
{"modelsStatus":200,"modelCount":65,
 "candidates":["gemini-flash-lite-latest","gemini-flash-latest","gemini-3.8-flash","gemini-3.7-flash"],
 "attempts":[{"model":"gemini-flash-lite-latest","ok":true}],
 "model":"gemini-flash-lite-latest","textOk":true,"textSample":"COPILOT OK","textLatencyMs":590,
 "visionOk":true,"visionSample":"- **Revenue:** 4.2 MILLION\n- **Status:** ON TRACK",
 "visionSawRevenue":true,"visionSawStatus":true,
 "credentialStored":true,"providerConfigured":true,"allowCloudPrivate":true}
```

- Text generation: verified ("COPILOT OK", 590 ms).
- **Vision: verified** against a real captured window — read both the revenue figure and the
  status verbatim, and both assertions passed.
- Credential stored encrypted (208-byte entry; the file contains no plaintext key).
- Provider row written: `gemini-flash-lite-latest`, vision enabled, active provider, hybrid mode.

### Model names move fast

During this verification Google **retired `gemini-2.5-flash` for new keys** (404 pointing at
`gemini-3.8-flash`), `gemini-3.8-flash` was returning `503 UNAVAILABLE` under load, and
`gemini-2.5-pro` was also retired. The harness discovers models from `/models` and retries
transient 429/503 across candidates; the first that answers is what gets saved.

If a model stops working, pick another in Settings → Providers; the app surfaces the provider's
message instead of guessing.

## Key handling

- The key is entered in Settings (or supplied to the verification harness via env var).
- It is written only through `CredentialStore` (OS-encrypted, DPAPI on Windows).
- It never appears in `settings.json`, source, logs or commits; the harness redacts key-shaped
  strings from everything it prints.
- Verified: repository search finds no key, and the credential file contains no plaintext.
