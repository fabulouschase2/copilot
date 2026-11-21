/**
 * Managed local speech recognition through whisper.cpp (Phase 1).
 *
 * Two things live here:
 *  1. `LocalWhisperManager` — owns the whisper-server child process: detection,
 *     start/stop, readiness, crash reporting and a bounded log tail.
 *  2. `LocalWhisperStt` — an STT adapter for the server's REAL interface.
 *
 * Verified against whisper.cpp 1.9.6-dev on this machine:
 *   POST /v1/audio/transcriptions → 404 (OpenAI compatibility does NOT exist)
 *   POST /inference  (multipart file) → 200 {"text":" And so my fellow Americans…"}
 *
 * The adapter therefore never reuses the OpenAI path; it posts to /inference
 * and reads `text`. Local transcription is final-only, like every other batch
 * adapter — partials are not faked.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  LocalWhisperSettings,
  WhisperCandidate,
  WhisperPhase,
  WhisperStatusInfo
} from '../../../shared/protocol'
import { encodeWav } from '../audio/pcm'
import { SegmentSttAdapter, SttResult, SttTranscribeRequest, mapSttHttpError } from './types'

const MAX_LOG_LINES = 40
const START_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 2_000

/** Executable locations inside a standard whisper.cpp checkout. */
const EXE_CANDIDATES = [
  path.join('build', 'bin', 'Release', 'whisper-server.exe'),
  path.join('build', 'bin', 'whisper-server.exe'),
  path.join('build', 'bin', 'RelWithDebInfo', 'whisper-server.exe'),
  'whisper-server.exe'
]

const MODEL_DIRS = ['.', 'models']

/**
 * Find usable whisper.cpp installs. Only paths that exist are returned, and
 * nothing is assumed: a machine without whisper.cpp simply yields [].
 */
export function detectWhisperInstalls(homeDir: string = os.homedir()): WhisperCandidate[] {
  const roots = new Set<string>()
  const envRepo = process.env['WHISPER_CPP_DIR']
  if (envRepo) roots.add(envRepo)
  roots.add(path.join(homeDir, 'whisper.cpp'))

  const candidates: WhisperCandidate[] = []
  for (const root of roots) {
    let exe: string | null = null
    for (const rel of EXE_CANDIDATES) {
      const full = path.join(root, rel)
      if (fs.existsSync(full)) {
        exe = full
        break
      }
    }
    if (!exe) continue
    for (const dir of MODEL_DIRS) {
      const modelDir = path.join(root, dir)
      let entries: string[] = []
      try {
        entries = fs.readdirSync(modelDir)
      } catch {
        continue
      }
      for (const file of entries) {
        if (!/^ggml-.*\.bin$/i.test(file)) continue
        const modelPath = path.join(modelDir, file)
        try {
          const stat = fs.statSync(modelPath)
          if (!stat.isFile() || stat.size < 1024) continue
          candidates.push({
            serverExe: exe,
            modelPath,
            modelSize: file.replace(/^ggml-/, '').replace(/\.bin$/i, ''),
            source: root
          })
        } catch {
          /* skip unreadable model */
        }
      }
    }
  }
  // Smallest models first: this machine has 8 GB RAM and no GPU.
  const order = (size: string): number => {
    const table = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'large-v3']
    const idx = table.indexOf(size)
    return idx === -1 ? 99 : idx
  }
  return candidates.sort((a, b) => order(a.modelSize) - order(b.modelSize) || a.modelPath.localeCompare(b.modelPath))
}

export interface StartResult {
  ok: boolean
  message: string
}

export class LocalWhisperManager {
  private child: ChildProcess | null = null
  private phase: WhisperPhase = 'stopped'
  private lastError: string | null = null
  private logTail: string[] = []
  private intentionalStop = false
  private starting: Promise<StartResult> | null = null
  private buffer = ''

  constructor(
    private getSettings: () => LocalWhisperSettings,
    private fetchImpl: typeof fetch = fetch,
    private spawnImpl: typeof spawn = spawn
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.getSettings().port}`
  }

  status(activeAsStt = false): WhisperStatusInfo {
    const s = this.getSettings()
    const serverExePresent = s.serverExe.length > 0 && fs.existsSync(s.serverExe)
    const modelPresent = s.modelPath.length > 0 && fs.existsSync(s.modelPath)
    return {
      phase: this.phase,
      port: s.port,
      baseUrl: this.baseUrl,
      serverExe: s.serverExe,
      modelPath: s.modelPath,
      serverExePresent,
      modelPresent,
      pid: this.child?.pid ?? null,
      message: this.describe(serverExePresent, modelPresent),
      lastError: this.lastError,
      logTail: this.logTail.slice(-MAX_LOG_LINES),
      activeAsStt
    }
  }

  private describe(serverExePresent: boolean, modelPresent: boolean): string {
    if (this.phase === 'running') return `whisper-server is running on port ${this.getSettings().port}.`
    if (this.phase === 'starting') return 'Starting whisper-server…'
    if (this.phase === 'failed') return this.lastError ?? 'whisper-server stopped unexpectedly.'
    if (!serverExePresent) return 'whisper-server.exe was not found — set its path in Settings.'
    if (!modelPresent) return 'No ggml model was found — set the model path in Settings.'
    return 'Local Whisper is configured but not running.'
  }

  /** Start if needed; resolves only when the HTTP server answers. */
  async ensureStarted(): Promise<StartResult> {
    if (this.phase === 'running' && (await this.healthy())) return { ok: true, message: 'already running' }
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<StartResult> {
    const s = this.getSettings()
    if (!s.serverExe) {
      this.phase = 'failed'
      this.lastError = 'whisper-server.exe path is not configured.'
      return { ok: false, message: this.lastError }
    }
    if (!fs.existsSync(s.serverExe)) {
      this.phase = 'failed'
      this.lastError = `whisper-server.exe not found at ${s.serverExe}`
      return { ok: false, message: this.lastError }
    }
    if (!s.modelPath || !fs.existsSync(s.modelPath)) {
      this.phase = 'failed'
      this.lastError = s.modelPath
        ? `Model file not found at ${s.modelPath}`
        : 'No whisper.cpp model selected.'
      return { ok: false, message: this.lastError }
    }

    // A previous instance may still be alive (crash recovery path).
    this.killChild()
    this.intentionalStop = false
    this.logTail = []
    this.lastError = null
    this.phase = 'starting'

    const args = [
      '-m', s.modelPath,
      '--host', '127.0.0.1',
      '--port', String(s.port),
      '-t', String(s.threads),
      '-l', s.language === 'auto' ? 'auto' : s.language
    ]
    let child: ChildProcess
    try {
      child = this.spawnImpl(s.serverExe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      this.phase = 'failed'
      this.lastError = `Could not start whisper-server: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, message: this.lastError }
    }
    this.child = child

    child.stdout?.on('data', (d: Buffer) => this.appendLog(d))
    child.stderr?.on('data', (d: Buffer) => this.appendLog(d))
    child.on('error', (err) => {
      this.phase = 'failed'
      this.lastError = `whisper-server error: ${err.message}`
    })
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.intentionalStop) {
        this.phase = 'stopped'
        return
      }
      this.phase = 'failed'
      this.lastError = `whisper-server exited (${signal ? `signal ${signal}` : `code ${code}`}).${
        this.logTail.length > 0 ? ` Last output: ${this.logTail[this.logTail.length - 1]}` : ''
      }`
    })

    const ready = await this.waitUntilReady()
    if (!ready) {
      this.phase = 'failed'
      this.lastError =
        this.lastError ??
        `whisper-server did not become ready within ${Math.round(START_TIMEOUT_MS / 1000)}s.${
          this.logTail.length > 0 ? ` Last output: ${this.logTail[this.logTail.length - 1]}` : ''
        }`
      this.killChild()
      return { ok: false, message: this.lastError }
    }
    this.phase = 'running'
    return { ok: true, message: `whisper-server listening on ${this.baseUrl}` }
  }

  private async waitUntilReady(): Promise<boolean> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.phase === 'failed') return false
      if (await this.healthy()) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      })
      return res.status < 500
    } catch {
      return false
    }
  }

  stop(): void {
    this.intentionalStop = true
    this.killChild()
    this.phase = 'stopped'
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  private appendLog(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8')
    const parts = this.buffer.split(/\r?\n/)
    this.buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      this.logTail.push(trimmed.slice(0, 300))
    }
    if (this.logTail.length > MAX_LOG_LINES * 2) {
      this.logTail = this.logTail.slice(-MAX_LOG_LINES)
    }
  }

  dispose(): void {
    this.stop()
  }
}

/**
 * STT adapter for a locally managed whisper.cpp server. Batch only; the
 * capability flags match every other segment adapter.
 */
export class LocalWhisperStt implements SegmentSttAdapter {
  readonly kind = 'stt-segment' as const
  readonly label = 'Local Whisper (whisper.cpp)'
  readonly capabilities = { partial: false, final: true, transport: 'http-batch' as const }

  constructor(
    private manager: LocalWhisperManager,
    private language?: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async transcribe(req: SttTranscribeRequest): Promise<SttResult> {
    const started = await this.manager.ensureStarted()
    if (!started.ok) throw new Error(started.message)

    const timeout = AbortSignal.timeout(req.timeoutMs ?? 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const wav = encodeWav(req.pcm, 16_000)
    const form = new FormData()
    form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'segment.wav')
    form.append('temperature', '0.0')
    form.append('response_format', 'json')
    const language = req.language ?? this.language
    if (language && language !== 'auto') form.append('language', language)

    let res: Response
    try {
      res = await this.fetchImpl(`${this.manager.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal
      })
    } catch (err) {
      if (signal.aborted) throw new Error('Transcription cancelled')
      throw new Error(
        `Could not reach the local Whisper server: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!res.ok) throw new Error(mapSttHttpError(res.status))
    const parsed = (await res.json()) as { text?: unknown }
    if (typeof parsed?.text !== 'string') {
      throw new Error('The local Whisper server returned an unexpected response')
    }
    return { text: parsed.text.trim() }
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const t0 = Date.now()
    const started = await this.manager.ensureStarted()
    if (!started.ok) return { ok: false, message: started.message, latencyMs: null }
    return { ok: true, message: 'Local Whisper server is running', latencyMs: Date.now() - t0 }
  }
}
