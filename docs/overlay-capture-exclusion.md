# Private overlay & Windows capture exclusion (Phase 6)

Status: **implemented and verified on this machine** (Windows 11 Pro, build 22000).
Last verified: 2026-11-21.

## What it is

A separate, frameless, always-on-top window that shows live interviewer captions and
the latest generated answer. On Windows it is marked `WDA_EXCLUDEFROMCAPTURE` via
`SetWindowDisplayAffinity`, so capture APIs that honour that flag — including
Chromium's own screen capture path used by the app's screen reader — do not include
it in their output.

The overlay is **visible to anyone physically looking at the screen**. It is not a
hidden window, and nothing else on the desktop is altered.

## Why the UI shows the OS value, not the setting

`SetWindowDisplayAffinity` can fail (wrong HWND, policy, unsupported build). Reporting
"private" based on a checkbox would be a lie, so:

- `OverlayStateInfo.exclusionActive` is `true` **only** when
  `GetWindowDisplayAffinity` returns exactly `0x11` after applying.
- If exclusion was requested but the OS reports something else, the panel shows
  "Exclusion was not applied" plus the Win32 error code.
- On unsupported platforms/builds the overlay still works, and the panel says capture
  exclusion is unavailable instead of degrading silently.

## Measured evidence (this machine)

Probe test — a solid-magenta 320×240 window, screen captured through Electron's
`desktopCapturer` at 1280×720, once with affinity cleared and once excluded:

```json
{"support":"supported","supportMessage":"Windows build 22000 supports WDA_EXCLUDEFROMCAPTURE.",
 "clearOk":true,"affinityCapturable":0,
 "applyOk":true,"affinityExcluded":17,"osConfirmsExclusion":true,
 "magentaShareCapturable":0.08206,"magentaShareExcluded":0,
 "captureSize":"1280x720",
 "probeVisibleWhenCapturable":true,"probeHiddenWhenExcluded":true}
```

Interpretation: 8.21% of the captured frame was the probe window while capturable;
**0%** after exclusion, and the OS echoed `0x11` (`17`). This proves the flag takes
effect on the Chromium capture path — it is not merely "the call returned 1".

Window integration test — the real `OverlayController`, production `overlay.html`,
sandboxed preload, no mocks:

```json
{"windowCreated":true,"windowVisible":true,"alwaysOnTop":true,
 "reactMounted":true,"statusText":"● excluded from capture","statusShowsExclusion":true,
 "contentRendered":true,"affinity":17,"exclusionActive":true,"stateEvents":2}
```

Reproduce:

```powershell
$env:COPILOT_SELFTEST='overlay';        .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='overlay-window'; .\node_modules\electron\dist\electron.exe .
```

## What is NOT verified

These are explicitly **not** claimed, because they were not tested here:

- **OBS Studio** (display capture, window capture, recording, streaming) — OBS was not
  installed on this machine, so its capture backends were not exercised.
- **Google Meet / Chrome** tab, window and entire-screen sharing.
- Third-party recorders, capture cards, virtual cameras, and hardware capture.

Windows documents that `WDA_EXCLUDEFROMCAPTURE` affects "screen capture, screen
recording, and screen sharing APIs", but individual applications may use methods that
bypass or ignore it (hardware capture, pointing a camera at the display, some remote
desktop paths). **Verify with the exact tool you rely on before depending on it.**

## Requirements and failure modes

| Condition | Behaviour |
|---|---|
| Windows 10 2004 (build 19041) or newer | Exclusion available |
| Windows older than 19041 | Overlay works; panel reports unsupported OS |
| macOS / Linux | Overlay works; panel reports unsupported platform |
| `koffi` native binding missing | Panel reports binding unavailable; app still runs |
| `SetWindowDisplayAffinity` fails | Panel shows the Win32 error code (5 = access denied, 87 = invalid parameter) |
| User turns the toggle off | Affinity reset to `WDA_NONE`; verified by reading it back |

The flag is applied **only** to the overlay window handle. The main window, other
applications, and the desktop are never modified.

## Privacy stance

- No screen content is recorded, transmitted, or stored by the overlay.
- No attempt is made to evade proctoring, monitoring, or assessment controls.
- Users must follow the rules of their meeting, workplace, or assessment.
