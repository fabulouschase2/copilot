import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static renderer contracts — a guard for the bug class that shipped in
 * v0.2.0: a session view that calls prepareTranscript/beginTranscript but
 * NEVER starts renderer capture, leaving the main process "listening" with
 * zero audio flowing while the UI said Listening. Vitest cannot run the
 * DOM/audio stack, so these wiring contracts are pinned by source inspection.
 * They document required wiring; behavioral audio tests live in
 * audio-pipeline.test.ts and the real-device procedures in
 * docs/full-functionality-audit.md.
 */

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', rel), 'utf-8')

describe('renderer capture contracts (regression: silent interview session)', () => {
  it('InterviewPanel starts renderer capture and streams chunks when a session begins', () => {
    const src = read('InterviewPanel.tsx')
    expect(src).toContain("startCapture(")
    expect(src).toContain("sendAudioChunk(")
    expect(src).toContain("captureRef.current?.stop()")
    // capture must be started on the start path (not merely imported)
    expect(src).toMatch(/startInterview[\s\S]{0,900}startCapture\(/s)
    // audio pipeline errors must be surfaced, never swallowed
    expect(src).toContain("onTranscriptError(")
    // device loss must be handled
    expect(src).toMatch(/onEnded\(/)
  })

  it('MeetingPanel keeps its own capture wiring', () => {
    const src = read('MeetingPanel.tsx')
    expect(src).toContain("startCapture(")
    expect(src).toContain("sendAudioChunk(")
    expect(src).toContain("onTranscriptError(")
  })

  it('PracticePanel keeps its own capture wiring for spoken answers', () => {
    const src = read('PracticePanel.tsx')
    expect(src).toContain("startCapture(")
    expect(src).toContain("sendAudioChunk(")
  })

  it('every session view tags its sessions with a purpose', () => {
    expect(read('InterviewPanel.tsx')).toMatch(/prepareTranscript\([^)]*'interview'/s)
    expect(read('MeetingPanel.tsx')).toMatch(/prepareTranscript\([^)]*'meeting'/s)
    expect(read('PracticePanel.tsx')).toMatch(/prepareTranscript\([^)]*'practice'/s)
  })

  it('the diagnostics view exists and is reachable from the shell', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'AudioDiagnosticsModal.tsx'))).toBe(true)
    const app = read('App.tsx')
    expect(app).toContain('AudioDiagnosticsModal')
  })

  it('capture reports diagnostics state (chunks, sample rate) for the diagnostics view', () => {
    const src = read('audio/capture.ts')
    expect(src).toContain('resetCaptureDiagnostics(')
    expect(src).toContain('sampleRate')
    expect(src).toContain('chunksSent')
  })
})


describe('renderer credential-management contracts (v0.2.3)', () => {
  it('provider key fields use the explicit Save key control, never onBlur saves', () => {
    const keyField = read('KeyField.tsx')
    expect(keyField).toContain('Save key')
    expect(keyField).toContain("saveCredential(")
    expect(keyField).toMatch(/onKeyDown[\s\S]{0,80}save/) // Enter saves explicitly
    expect(keyField).not.toMatch(/onBlur\s*=/) // the shipped bug: silent onBlur saves
    // input clears only on success
    expect(keyField).toMatch(/if \(result\.ok\)[\s\S]{0,60}setValue\(''\)/s)
    // secret never logged
    expect(keyField).not.toMatch(/console\.log/)
  })

  it('both provider editors use KeyField with credential badges', () => {
    const inline = read('SetupProvidersInline.tsx')
    expect(inline).toContain('<KeyField')
    expect(inline).toContain('Test connection') // STT connection test
    expect(inline).toContain('listSttProviders')
    const setup = read('SetupPanel.tsx')
    expect(setup).toContain('<KeyField')
    expect(setup).not.toContain('onBlur={(e) => {') // no legacy silent saves
  })

  it('the credentials helper validates empty keys before any IPC call', () => {
    const helper = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'credentials.ts'), 'utf-8')
    expect(helper).toMatch(/Enter a key first/)
    expect(helper).toMatch(/secret\.length === 0[\s\S]{0,300}return \{ ok: false/)
  })
})
