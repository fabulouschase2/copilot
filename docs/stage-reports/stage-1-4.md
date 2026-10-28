# Stage Report — Stages 0–4 (2026-10-24)

## Files created or changed

**Research (Stage 1):** `docs/product-research.md`, `docs/feature-comparison.md`, `docs/feature-evidence.md`
**Architecture (Stage 2):** `docs/architecture.md` (stack decision, component map, IPC/provider/context contracts, security model, resource budget)
**App (Stages 3–4):**
- `package.json`, `electron.vite.config.ts`, `tsconfig{,.node,.web}.json`, `.gitignore`
- `src/shared/protocol.ts` — IPC contract, zod schemas, `CopilotApi`
- `src/main/` — `index.ts` (lifecycle, Ctrl+Alt+C), `window.ts`, `ipc.ts`, `services/`: `chat-controller.ts`, `provider-registry.ts`, `context-engine.ts`, `credential-store.ts`, `settings-store.ts`, `providers/types.ts`, `providers/openai-compatible.ts`
- `src/preload/index.ts` — sandboxed typed bridge
- `src/renderer/` — `index.html` (CSP), `src/main.tsx`, `App.tsx`, `ChatPanel.tsx`, `SettingsPage.tsx`, `theme.css`
- `tests/` — 5 suites, 32 tests
- `README.md`, `scripts/extract-electron.cjs` (npm-11 postinstall workaround)

## Features implemented (verified)

- **Stage 1:** all three products resolved with sources; Poisely installer forensically identified (NSIS, v1.2.2, ~97 MB, signed, self-described capture-invisible overlay). Competitor feature capture-evasion documented and **excluded by design** in ours.
- **Stage 3:** Electron shell launches (smoke-tested: process alive 8 s, closed cleanly); resizable floating window; pin/always-on-top toggle; dark+light themes; global shortcut Ctrl+Alt+C; single-instance; tabbed UI.
- **Stage 4:** `AIProvider` interface; OpenAI-compatible adapter (hosted + local endpoints, SSE streaming, `[DONE]`, error mapping, cancel+timeout via `AbortSignal.any`); secure key storage (safeStorage; refuses plaintext without opt-in); validated settings persistence; **hot provider switching per request** (user requirement); connectivity test with measured latency; streaming chat UI with Stop/Regenerate/Copy; concise/detailed modes.
- **Context engine core:** dedup, pinned items, count/age eviction, token-budgeted rolling window (built + tested; sources wired in Stage 7).

## Tests executed and results

- `tsc --noEmit` main + renderer: **0 errors**
- `vitest run`: **32/32 passed** in 5 suites (adapter SSE parsing/boundaries/error-mapping/no-key-leak/cancel; context dedup/eviction/budget/pin; credential roundtrip/no-plaintext-refusal/corrupt-file; settings defaults/roundtrip/corrupt; IPC schema rejection)
- `electron-vite build`: **success** (renderer 823 kB JS — zod included; fine for a desktop app, lazy-load if it grows)
- Smoke launch: **4 electron.exe processes observed, window booted, killed cleanly**

## Known limitations (honest list)

1. No audio, screen capture, vision, or persistence yet — Stages 5–9.
2. Chat context is in-memory per launch; history is not saved yet.
3. Only the OpenAI-compatible adapter exists; Anthropic/Gemini/STT adapters are future work on the same interface.
4. `max_tokens` parameter name used (some newer OpenAI models prefer `max_completion_tokens`; adapter needs a per-provider quirk table if that bites).
5. npm 11 blocked postinstall scripts; Electron binary needed one manual extraction (documented in README; `scripts/extract-electron.cjs`).
6. UI is functional-first; polish (font-size controls, overlay styling, i18n) comes with Stage 10.
7. Research evidence is vendor-published only; no competitor runtime behavior was observed (none executed).

## Outstanding tasks → next stage

**Stage 5 (next):** audio engine — mic + system loopback capture (WebAudio/WASAPI), VAD, pluggable STT adapters (provider-based first per the modest-RAM budget), partial/final transcript events feeding the context engine; memory + latency baselines measured on this machine.
Then: Stage 6 screen capture/vision; Stage 7 wire transcript+screen into ContextEngine; Stage 8 interview (prep/practice framing) + meeting modes; Stage 9 SQLite; Stage 10 hardening; Stage 11 E2E+packaging; Stage 12 parity audit.
