# CHANGELOG

All notable user-facing changes. Versions follow the app's `package.json`.

## Unreleased — Klevi-level transformation

### Added

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

- Capture exclusion requires Windows 10 version 2004 (build 19041) or newer. On older
  builds and other platforms the overlay still works and says exclusion is unavailable.
- OBS Studio and Google Meet were not available for testing; their behaviour is
  unverified and not claimed.
