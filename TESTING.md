# TESTING

## Automated

```powershell
npm test            # vitest: 353 tests, 43 files (after Phase 2)
npm run typecheck   # tsc, main + renderer
npm run build       # electron-vite production build
```

Baseline before this work was 282 tests; every phase below added coverage and the suite must stay
green (no skipped or silenced failures).

## Self-test harnesses (real behaviour, not assertions about intentions)

Each prints one JSON line to stdout and exits.

```powershell
$env:COPILOT_SELFTEST='overlay';        .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='overlay-window'; .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='whisper';        .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='translation';    .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='story';          .\node_modules\electron\dist\electron.exe .
$env:COPILOT_SELFTEST='ui';             .\node_modules\electron\dist\electron.exe .
```

| Harness | What it proves | Last result |
|---|---|---|
| `overlay` | A probe window is present in a real screen capture when capturable and absent when excluded | 8.21% → 0% magenta share, affinity `0x11` |
| `overlay-window` | The real `overlay.html` mounts, reports "excluded from capture", renders pushed content | all true, affinity 17 |
| `whisper` | Managed server starts, real WAV transcribes through the adapter | start 337 ms, transcribe 533 ms, text matched |
| `translation` | Real provider translates text and the live segment pipeline emits one event | EN→ES 3.7 s via Ollama |
| `story` | Draft from facts, save, then ranked retrieval | draft 17.9 s, score 0.505 |
| `ui` | All 7 nav views + Settings render with zero console errors | `emptyViews: []`, `consoleErrors: []` |

Optional: `$env:COPILOT_SHOT_DIR='<dir>'` with the `ui` harness writes PNG screenshots of every
view (used for `docs/screenshots/`).

## Packaged build

```powershell
npm run dist:dir
$env:COPILOT_SELFTEST='overlay'
Start-Process .\dist\win-unpacked\Copilot.exe -RedirectStandardOutput out.log -Wait
```

Verified: the packaged app applies capture exclusion (affinity `0x11`, 8.21% → 0%), which
confirms the native `koffi` binding survives asar packing (electron-builder unpacks `*.node`).

## Manual checks worth running

1. **Overlay vs. a recorder you actually use** (OBS, Teams, Meet). Windows documents that
   `WDA_EXCLUDEFROMCAPTURE` affects screen capture/recording/sharing APIs, but individual tools may
   differ. OBS and Google Meet were **not** available on this machine and remain unverified.
2. **Local Whisper in a live session** — start an interview session and confirm captions appear;
   check Settings → Local Whisper shows `running` with a pid.
3. **Translation with a real microphone** — the engine and provider path are verified; a live
   mic session was not.
4. **Story in an interview** — save a story, ask a matching question, and confirm the story block
   reaches the prompt (sources list shows `Career story: …`).
5. **Database upgrade** — open an existing v3 `context.db`; the app should add
   `career_stories` and keep all data.

## Known untested areas

- OBS and Google Meet capture behaviour.
- Cloud providers (Gemini/OpenAI): no key configured on this machine.
- Non-English speech, long (multi-hour) sessions, and memory pressure on 8 GB hardware.
- macOS and Linux builds.
