# PROGRESS

Live development log for the Klevi-level transformation. One section per completed
phase, with what was built, what was tested, and where the evidence lives.

Branch: `feature/klevi-level-transformation`

## Baseline (before any change)

Measured on the user's machine (Windows 11 Pro, build 22000, i5 11th gen, 8 GB RAM):

| Check | Result |
|---|---|
| `npm install` | OK (Electron binary requires `node node_modules/electron/install.js` under npm 11 script gating) |
| `npm test` | **282 / 282 passed**, 39 files |
| `npm run typecheck` | pass (main + renderer) |
| `npm run build` | pass (`out/main`, `out/preload`, `out/renderer`) |

The repository's own claims (282 tests, Electron 38, React 19, SQLite) were accurate
when checked against the code, so no architectural replacement was justified.

## Phase 0 — audit and protection

- Repository cloned and inspected: 129 tracked files, single `master` branch, clean tree.
- Existing stack verified: Electron 38.8.6, React 19, TypeScript 5, electron-vite,
  zod 4, `node:sqlite` persistence, OpenAI-compatible provider adapter.
- Working branch created from `master`; `master` untouched; no force-pushes.
- Baseline captured above; every later phase is compared against it.

## Phase 6 — private desktop overlay (delivered)

Scope note: the previous roadmap deliberately excluded a capture-invisible overlay.
This phase reverses that decision *only* for the overlay window, with the user's
explicit requirement, and keeps the honesty rules: the OS value is what gets shown.

Implemented:

- `src/main/services/overlay/display-affinity.ts` — `SetWindowDisplayAffinity` /
  `GetWindowDisplayAffinity` bound through koffi (prebuilt FFI, no compiler). Lazy,
  defensive loading; failures carry the Win32 code.
- `src/main/services/overlay/overlay-state.ts` — pure support assessment and state
  derivation (`exclusionActive` is true only when the OS echoes `0x11`).
- `src/main/overlay-window.ts` — frameless always-on-top window, persisted bounds,
  opacity/font-size, live caption + answer mirroring, per-window affinity, restore on
  startup, close-to-disable.
- `src/shared/protocol.ts` — overlay settings (`enabled`, `captureExcluded`, `opacity`,
  `fontSize`, `showCaptions`), IPC channels, bounded content schema.
- `src/renderer/overlay.html`, `src/renderer/src/overlay.tsx`, `overlay.css` — second
  renderer document (multi-page electron-vite build).
- `src/renderer/src/OverlayPanel.tsx` + nav item + header chip — toggles, OS-reported
  status, error codes, and an explicit "does / does not" list.
- Global shortcut `Ctrl+Alt+O`.
- `src/main/selftest.ts` — two verification harnesses (pixel-level capture test,
  real-window integration test).

Verified:

- Pixel test: magenta probe covered 8.21% of the captured frame when capturable and
  **0%** when excluded; OS affinity `0x11`. See `docs/overlay-capture-exclusion.md`.
- Window test: real `overlay.html` mounts, shows "excluded from capture", renders
  pushed content.
- `tests/overlay-phase6.test.ts`: 18 tests (support matrix, no-over-claim state
  derivation, Win32 error mapping, HWND parsing, schema bounds).
- Full suite after the phase: **300 / 300 passed**; typecheck and build clean.

Not verified (do not claim): OBS Studio and Google Meet capture behaviour — neither was
available on this machine.

## Remaining phases

Tracked in `FEATURE_STATUS.md`. Cloud sync, billing and the phone companion require
external infrastructure and credentials that this machine does not have; they are
listed there as blocked rather than mocked up.
