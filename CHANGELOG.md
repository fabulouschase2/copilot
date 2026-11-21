# CHANGELOG

All notable user-facing changes. Versions follow the app's `package.json`.

## Unreleased — Klevi-level transformation

### Added

- **Live translation** (Phase 4): capture mic or system audio and see each finalized utterance
  translated into any of 49 target languages, with the producing provider named on every line.
  Translated captions also appear in the private overlay. Verified with a real local model
  (English → Spanish, 3.7 s); cloud providers were not exercised.
- **Local speech recognition** (Phase 1): Copilot manages a local whisper.cpp server — detection,
  start/stop, readiness checks, crash reporting — so transcription can run entirely on-device with
  no API key. Measured 11 s of audio transcribed in 0.53 s on CPU with the `tiny` model.
- **Private overlay window** (Phase 6): a frameless, always-on-top assistant surface
  that shows live interviewer captions and the latest answer, with font-size and
  opacity controls.
- **Windows capture exclusion**: the overlay is marked `WDA_EXCLUDEFROMCAPTURE`, so
  screen-capture APIs that honour the flag omit it from their output. The UI reports
  the OS-confirmed affinity, not the requested setting.
- **`Ctrl+Alt+O`** global shortcut to show or hide the overlay.
- **Overlay panel** with per-window status, Win32 error codes when the API fails, and
  a plain-language list of what capture exclusion does and does not cover.
- Two verification harnesses (`COPILOT_SELFTEST=overlay`, `overlay-window`) that
  measure capture behaviour instead of asserting it.

### Changed

- `koffi` (prebuilt FFI) added as the Windows binding for `user32` display affinity.
- The renderer build now emits two documents (`index.html` and `overlay.html`).
- README no longer states that a capture-excluded overlay is out of scope; the
  exclusion is now scoped to the overlay window only and documented with evidence.

### Notes

- whisper.cpp's server exposes `/inference`, not the OpenAI `/audio/transcriptions` route
  (verified 404 on 1.9.6-dev); the local adapter uses the real contract.
- Capture exclusion requires Windows 10 version 2004 (build 19041) or newer. On older
  builds and other platforms the overlay still works and says exclusion is unavailable.
- OBS Studio and Google Meet were not available for testing; their behaviour is
  unverified and not claimed.
