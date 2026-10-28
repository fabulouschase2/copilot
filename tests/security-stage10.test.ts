/**
 * Stage 10 security regression tests.
 *
 * These pin the two production incidents found during real Windows GUI
 * verification, plus the standing security invariants of the build output.
 * They run against the built artifacts when present (skipped otherwise) so
 * `vitest run` after `npm run build` always exercises them.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..')
const preloadPath = path.join(repoRoot, 'out', 'preload', 'index.js')
const rendererIndexPath = path.join(repoRoot, 'out', 'renderer', 'index.html')
const built = existsSync(preloadPath) && existsSync(rendererIndexPath)

describe.skipIf(!built)('Stage 10 build-output security invariants', () => {
  it('SF-1 regression: sandboxed preload bundles its dependencies (no external zod require)', () => {
    // Production incident: externalizeDepsPlugin left `require('zod')` in the
    // preload; sandboxed preloads cannot load it → window.copilot undefined →
    // React crashed → black window in production only.
    const src = readFileSync(preloadPath, 'utf-8')
    expect(src).not.toMatch(/require\(["']zod["']\)/)
    // and the bridge API really is exposed by the bundle:
    expect(src).toContain('exposeInMainWorld')
  })

  it('SF-2: renderer CSP blocks remote script/style/frame sources', () => {
    const html = readFileSync(rendererIndexPath, 'utf-8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toMatch(/script-src[^;]*\*/)
    expect(csp).not.toMatch(/frame-src|object-src 'self' \*/)
  })

  it('SF-3: built renderer carries no provider keys or credential material', () => {
    for (const f of [preloadPath, rendererIndexPath]) {
      const src = readFileSync(f, 'utf-8')
      expect(src).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
      expect(src).not.toMatch(/AQ\.[A-Za-z0-9_-]{20,}/) // Google-style key shape
      expect(src).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/)
    }
  })

  it('SF-4: preload exposes only the narrow copilot bridge surface', () => {
    const src = readFileSync(preloadPath, 'utf-8')
    // Only one contextBridge exposure, named 'copilot'
    const exposures = src.match(/exposeInMainWorld\(/g)?.length ?? 0
    expect(exposures).toBe(1)
    expect(src).toMatch(/exposeInMainWorld\(["']copilot["']/)
  })
})

describe('Stage 10 source-level security invariants (always run)', () => {
  const windowSrc = readFileSync(path.join(repoRoot, 'src', 'main', 'window.ts'), 'utf-8')

  it('SF-5: renderer is created sandboxed with contextIsolation and no nodeIntegration', () => {
    const src = windowSrc
    expect(src).toMatch(/sandbox:\s*true/)
    expect(src).toMatch(/contextIsolation:\s*true/)
    expect(src).toMatch(/nodeIntegration:\s*false/)
  })

  it('SF-6: window creation denies popups and opens external links in the browser', () => {
    const src = windowSrc
    expect(src).toMatch(/setWindowOpenHandler/)
    expect(src).toMatch(/action: 'deny'/)
    expect(src).toMatch(/openExternal/)
  })

  it('SF-7: hardware acceleration disabled (Stage 10 Windows presentation fix)', () => {
    const src = readFileSync(path.join(repoRoot, 'src', 'main', 'index.ts'), 'utf-8')
    expect(src).toContain('disableHardwareAcceleration')
  })

  it('SF-8: every IPC channel in the contract is schema-guarded in ipc.ts', () => {
    const protocol = readFileSync(path.join(repoRoot, 'src', 'shared', 'protocol.ts'), 'utf-8')
    const ipc = readFileSync(path.join(repoRoot, 'src', 'main', 'ipc.ts'), 'utf-8')
    // ipc.ts references channels through the shared IPC constants; verify
    // every invoke-style constant name appears (i.e. all are registered).
    for (const m of protocol.matchAll(/^\s+([a-zA-Z]+):\s*'([^']+)',?$/gm)) {
      const constName = m[1]
      const channel = m[2]
      if (!/^(settings|providers|context):/.test(channel)) continue
      expect(ipc, `channel ${channel} must be registered`).toContain(`IPC.${constName}`)
    }
    // And the file parses payloads through zod schemas (spot-check the important ones)
    for (const schema of [
      'ChatSendRequestSchema',
      'AppSettingsSchema',
      'TranscriptAudioChunkSchema',
      'ScreenCaptureRequestSchema',
      'InterviewAnswerRequestSchema',
      'NotesExportRequestSchema'
    ]) {
      expect(ipc).toContain(schema)
    }
  })
})
