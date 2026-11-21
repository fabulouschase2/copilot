# Local speech recognition (whisper.cpp) — Phase 1

Status: **implemented and verified end-to-end on this machine**.
Last verified: 2026-11-21. whisper.cpp 1.9.6-dev, `ggml-tiny.bin` (74 MB), Windows 11 22000,
i5 11th gen, no GPU.

## What Copilot does

Copilot owns the whisper.cpp server process:

1. Detects `whisper-server.exe` and `ggml-*.bin` in a standard checkout
   (`%USERPROFILE%\whisper.cpp`, or `WHISPER_CPP_DIR`), and offers every model it finds.
2. Spawns `whisper-server.exe -m <model> --host 127.0.0.1 --port <port> -t <threads>` when a
   session first needs transcription — the user never starts it manually.
3. Waits for the HTTP port to answer before declaring the server ready (30 s budget).
4. Transcribes each VAD-delimited utterance, then reports real state: pid, phase, log tail,
   and the exact failure when something breaks.
5. Stops the child on app quit. Verified: zero orphan `whisper-server` processes after a run.

## The interface is not OpenAI-compatible (measured)

This matters because assuming otherwise produces silent 404s:

```
POST /v1/audio/transcriptions  ->  HTTP 404  File Not Found
POST /inference                ->  HTTP 200  {"text":" And so my fellow Americans ask not…"}
```

So `LocalWhisperStt` posts multipart audio to `/inference` and reads `text`. It is declared
`partial: false, final: true, transport: 'http-batch'` — the same honest capability profile as
every other batch STT adapter. No partials are invented.

## Measured end-to-end result

```
{"candidates":1,"modelSize":"tiny","startOk":true,
 "startMessage":"whisper-server listening on http://127.0.0.1:8137",
 "startMs":337,"transcribeMs":533,"sampleSeconds":11,
 "text":"And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.",
 "textMatches":true,"nonEmpty":true,"phaseAfter":"running","pid":16484,"logLines":36}
```

Server cold start ≈ 0.33 s; 11 s of audio transcribed in ≈ 0.53 s on CPU. Reproduce with:

```powershell
$env:COPILOT_SELFTEST='whisper'; .\node_modules\electron\dist\electron.exe .
```

## Configuration

Settings → Providers → **Local speech recognition (whisper.cpp)**:

| Field | Meaning |
|---|---|
| Executable | `whisper-server.exe` (required) |
| Model | any `ggml-*.bin` (required) |
| Port | 1024–65535 (default 8123) |
| Threads | 1–16; 4 is a sensible default on this CPU |
| Language | `auto` or a specific code |
| Use for transcription | Creates/activates the `local-whisper` STT row |

Detection is a convenience, never an assumption: if no checkout exists the panel says so and
the fields stay manual.

## Resource notes (8 GB RAM, no GPU)

- `tiny` is the default recommendation: ~74 MB model, ~130 MB RSS while serving.
- `base` is a reasonable accuracy step up; `small` and above compete with the app for memory.
- The server is stopped on quit, so it does not hold RAM between sessions.
- Transcription is CPU-bound; expect roughly real-time or faster for short utterances on this
  hardware (measured 0.53 s for 11 s of audio with `tiny`).

## Not verified

- Languages beyond English were not exercised with real audio (the model is multilingual, but
  no non-English sample was transcribed here).
- Long meetings (hours) were not load-tested; only bounded utterances were.
- Accuracy on accented/noisy speech was not benchmarked.
