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

## Correction and full capture-path matrix (2026-11-21)

**A defect was found while verifying this properly.** The overlay window was created with
`transparent: true` while the app disables hardware acceleration (a Stage 10 fix for black windows
on hybrid GPUs). Windows does not composite a transparent BrowserWindow in that configuration, so
the overlay was **never actually visible on screen** — `BrowserWindow.isVisible()` returned true,
but nothing was painted. It was only detectable by measuring screen pixels.

Fixed by making the overlay window opaque (`transparent: false`, solid background). The card look
is preserved by painting the backing colour behind the rounded card.

### Measured, with the fixed build

`COPILOT_SELFTEST=privacy` paints the real overlay magenta, then measures the magenta share of four
capture paths with exclusion off and on. Control: an opaque 240×120 window at (40,40) captured
through GDI shows **74.1%** coverage in both states, proving the capture paths work.

| Capture path | Exclusion off | Exclusion on | Result |
|---|---|---|---|
| Chromium display capture (`desktopCapturer`, screen source) | 17.7% | **0%** | hidden |
| GDI `BitBlt` (PowerShell `CopyFromScreen`, whole screen) | 14.8% | **0%** | hidden |
| GDI `BitBlt` of the overlay's own rectangle | 15.0% | **0%** | hidden |
| `PrintWindow(PW_RENDERFULLCONTENT)` on the overlay HWND | 96.8% | **0%** | hidden |
| Chromium window capture (window source for the overlay) | 98.6% | **98.4%** | **NOT hidden** |

Reproduce:

```powershell
$env:COPILOT_SELFTEST='privacy'; .\node_modules\electron\dist\electron.exe .
```

### What this means in practice

- **Entire-screen sharing / display recording** (Google Meet "entire screen", Chromium
  `getDisplayMedia`, OBS display capture, most recorders using GDI or WGC): the overlay is
  excluded where the OS honours the flag.
- **Individual-window capture of the overlay itself**: Chromium's window-source path still returns
  the window's own surface. Do not rely on exclusion against "share this specific window".
- **`PrintWindow`-based tools**: excluded (returns nothing) — but note Chromium does not implement
  `WM_PRINT`, so this path is unreliable for Electron windows in general.

### Still not verified

- **OBS Studio** is not installed on this machine, so its DXGI/WGC paths were not exercised
  directly. The Chromium display path and GDI cover the same OS-level exclusion mechanism.
- **Google Meet with a second participant** could not be tested: verifying what a remote peer sees
  requires a second account/device. The local display-capture path it uses is measured above.
