# SETUP

## Prerequisites

- Windows 10 (2004, build 19041) or newer / Windows 11 — primary target.
- Node.js ≥ 20 (verified with Node 24) and npm ≥ 10.
- Optional: a local AI runtime (Ollama or LM Studio) for offline use.
- Optional: a whisper.cpp checkout for offline speech recognition.

## Install

```powershell
npm install
```

**npm 11 blocks install scripts by default.** Electron's binary and esbuild's postinstall do not
run automatically, which later fails with "Electron failed to install correctly". Fix:

```powershell
npm install-scripts approve electron
node node_modules/electron/install.js
```

`koffi` (the Windows FFI used for capture exclusion) ships a prebuilt binary; its blocked install
script does not need to run. Verified working after `npm install` alone.

## Run and build

```powershell
npm run dev        # hot-reload development
npm run build      # production bundles in out/
npm test           # vitest
npm run typecheck  # tsc, main + renderer
npm run dist       # NSIS installer in dist/
npm run dist:dir   # unpacked app in dist/win-unpacked (fast check)
```

Do not save `package.json` with a BOM — electron-builder fails with
`readObjectStart: expect { or n, but found`.

## AI providers (chat)

Settings → Providers. Any OpenAI-compatible endpoint works.

| Provider | Base URL | Key |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | required |
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Groq | `https://api.groq.com/openai/v1` | required |
| Ollama (local) | `http://127.0.0.1:11434/v1` | not needed |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | not needed |

Keys are stored OS-encrypted (DPAPI) and never reach the renderer. "Test connection" reports
measured latency.

Verified locally with Ollama `qwen2.5:1.5b`: translation and story drafting both work with no
key. For better translation quality, use a larger cloud model.

## Local speech recognition (whisper.cpp)

Copilot manages the server; you do not run it yourself.

1. Build or download whisper.cpp and note the paths:
   - `whisper-server.exe` (e.g. `<repo>\build\bin\Release\whisper-server.exe`)
   - a model (e.g. `<repo>\ggml-tiny.bin`)
2. Settings → Providers → **Local speech recognition (whisper.cpp)** → **Detect install**, or
   paste the paths manually.
3. Press **Use for transcription**.

The server is spawned on demand (`127.0.0.1:<port>`, default 8123), health-checked, and stopped
when the app quits.

Note: whisper.cpp's server exposes `POST /inference`, **not** the OpenAI
`/v1/audio/transcriptions` route (verified 404 on 1.9.6-dev). Copilot uses the real contract.

## Screen capture and audio permissions

- Microphone and system audio are granted per session, from an explicit **Start** click.
- Screen reading requires arming consent in the modal; each capture is one-shot.
- Capture exclusion applies only to the overlay window and requires Windows build 19041+.

## Data locations

| Item | Location |
|---|---|
| Settings | `%APPDATA%\Copilot\settings.json` |
| Database (schema v4) | `%APPDATA%\Copilot\context.db` |
| Backups | `%APPDATA%\Copilot\backups\` |
| Window bounds | `%APPDATA%\Copilot\window-bounds.json`, `overlay-bounds.json` |
| API keys | OS credential store (`safeStorage`), never in these files |

There is no encryption at rest for the SQLite database (documented limitation); it relies on OS
file permissions.
