/**
 * Phase 1 â€” managed local whisper.cpp tests.
 *
 * Contract facts pinned here (measured against whisper.cpp 1.9.6-dev):
 *  - the server answers at POST /inference, NOT /v1/audio/transcriptions;
 *  - the adapter never fabricates partials (batch only);
 *  - a missing executable/model fails with a precise message instead of
 *    silently falling back to a cloud provider.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSettingsSchema, STTProviderSchema, WhisperConfigureRequestSchema } from '../src/shared/protocol'
import {
  LocalWhisperManager,
  LocalWhisperStt,
  detectWhisperInstalls
} from '../src/main/services/stt/local-whisper'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeInstall(home: string, withModels: string[]): string {
  const root = path.join(home, 'whisper.cpp')
  const exe = path.join(root, 'build', 'bin', 'Release', 'whisper-server.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'binary')
  for (const name of withModels) {
    fs.writeFileSync(path.join(root, `ggml-${name}.bin`), Buffer.alloc(2048))
  }
  return root
}

describe('whisper.cpp installation detection', () => {
  it('finds the executable and every ggml model, smallest first', () => {
    const home = tempDir()
    const root = makeInstall(home, ['small', 'tiny', 'base'])
    const found = detectWhisperInstalls(home)
    const fromRoot = found.filter((c) => c.source === root)
    expect(fromRoot.map((c) => c.modelSize)).toEqual(['tiny', 'base', 'small'])
    expect(fromRoot[0].serverExe).toContain('whisper-server.exe')
  })

  it('returns nothing when whisper.cpp is absent (no assumptions)', () => {
    expect(detectWhisperInstalls(tempDir())).toEqual([])
  })

  it('ignores model files that are not ggml-*.bin', () => {
    const home = tempDir()
    const root = makeInstall(home, [])
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(root, 'model.bin'), Buffer.alloc(2048))
    expect(detectWhisperInstalls(home).filter((c) => c.source === root)).toEqual([])
  })
})

describe('LocalWhisperManager lifecycle', () => {
  const baseSettings = {
    serverExe: '',
    modelPath: '',
    port: 8137,
    threads: 4,
    language: 'auto',
    autoStart: true
  }

  it('fails with a precise message when the executable is not configured', async () => {
    const manager = new LocalWhisperManager(() => baseSettings)
    const result = await manager.ensureStarted()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not configured|was not found/i)
    expect(manager.status().phase).toBe('failed')
  })

  it('fails clearly when the model file is missing', async () => {
    const home = tempDir()
    const root = makeInstall(home, [])
    const exe = path.join(root, 'build', 'bin', 'Release', 'whisper-server.exe')
    const manager = new LocalWhisperManager(() => ({
      ...baseSettings,
      serverExe: exe,
      modelPath: path.join(root, 'ggml-missing.bin')
    }))
    const result = await manager.ensureStarted()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Model file not found/)
  })

  it('starts, reports running, and stops without leaving a failed state', async () => {
    const home = tempDir()
    const root = makeInstall(home, ['tiny'])
    const exe = path.join(root, 'build', 'bin', 'Release', 'whisper-server.exe')
    const model = path.join(root, 'ggml-tiny.bin')

    const handlers: Record<string, (...args: never[]) => void> = {}
    const child = {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on: (event: string, cb: (...args: never[]) => void) => {
        handlers[event] = cb
        return child
      },
      kill: () => {
        handlers['exit']?.(0 as never, null as never)
      }
    }
    const spawnImpl = (() => child) as unknown as typeof spawn
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch

    const manager = new LocalWhisperManager(
      () => ({ ...baseSettings, serverExe: exe, modelPath: model }),
      fetchImpl,
      spawnImpl
    )

    const started = await manager.ensureStarted()
    expect(started.ok).toBe(true)
    expect(manager.status().phase).toBe('running')
    expect(manager.status().pid).toBe(4242)

    manager.stop()
    expect(manager.status().phase).toBe('stopped')
  })

  it('reports an unexpected exit with the child output instead of pretending', async () => {
    const home = tempDir()
    const root = makeInstall(home, ['tiny'])
    const exe = path.join(root, 'build', 'bin', 'Release', 'whisper-server.exe')
    const model = path.join(root, 'ggml-tiny.bin')

    let exitHandler: ((code: number, signal: null) => void) | null = null
    const child = {
      pid: 99,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on: (event: string, cb: (code: number, signal: null) => void) => {
        if (event === 'exit') exitHandler = cb
        return child
      },
      kill: () => undefined
    }
    const spawnImpl = (() => child) as unknown as typeof spawn
    // Never becomes healthy.
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    const manager = new LocalWhisperManager(
      () => ({ ...baseSettings, serverExe: exe, modelPath: model }),
      fetchImpl,
      spawnImpl
    )
    // Exit immediately after spawn.
    queueMicrotask(() => exitHandler?.(1, null))

    const started = await manager.ensureStarted()
    expect(started.ok).toBe(false)
    const status = manager.status()
    expect(status.phase).toBe('failed')
    expect(status.message).toMatch(/exited|ready/i)
  })
})

describe('LocalWhisperStt adapter', () => {
  const stubManager = (ok: boolean): LocalWhisperManager =>
    ({
      ensureStarted: async () => ({ ok, message: ok ? 'ok' : 'server unavailable' }),
      get baseUrl() {
        return 'http://127.0.0.1:9999'
      }
    }) as unknown as LocalWhisperManager

  it('posts multipart audio to /inference and returns the text', async () => {
    let calledUrl = ''
    let method = ''
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calledUrl = String(url)
      method = init.method ?? ''
      return new Response(JSON.stringify({ text: '  hello world  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const adapter = new LocalWhisperStt(stubManager(true), 'en', fetchImpl)
    const result = await adapter.transcribe({ pcm: new Int16Array(1600) })

    expect(result.text).toBe('hello world')
    expect(calledUrl).toBe('http://127.0.0.1:9999/inference')
    expect(calledUrl).not.toContain('audio/transcriptions')
    expect(method).toBe('POST')
  })

  it('declares batch-only capabilities (no fake partials)', () => {
    const adapter = new LocalWhisperStt(stubManager(true))
    expect(adapter.capabilities).toEqual({ partial: false, final: true, transport: 'http-batch' })
    expect(adapter.kind).toBe('stt-segment')
  })

  it('surfaces a server start failure as a transcription error', async () => {
    const adapter = new LocalWhisperStt(stubManager(false))
    await expect(adapter.transcribe({ pcm: new Int16Array(160) })).rejects.toThrow(/server unavailable/)
  })

  it('reports an unexpected payload instead of returning empty text', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch
    const adapter = new LocalWhisperStt(stubManager(true), 'en', fetchImpl)
    await expect(adapter.transcribe({ pcm: new Int16Array(160) })).rejects.toThrow(/unexpected response/)
  })

  it('maps HTTP failures through the shared STT message table', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    const adapter = new LocalWhisperStt(stubManager(true), 'en', fetchImpl)
    await expect(adapter.transcribe({ pcm: new Int16Array(160) })).rejects.toThrow(/server error \(500\)/)
  })
})

describe('local whisper settings contract', () => {
  it('defaults STT providers to the OpenAI wire protocol', () => {
    const parsed = STTProviderSchema.parse({
      id: 'p1',
      label: 'Groq',
      kind: 'stt-segment',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3',
      enabled: true
    })
    expect(parsed.protocol).toBe('openai')
    expect(parsed.language).toBe('en')
  })

  it('defaults local whisper to unconfigured paths and no forced language', () => {
    const settings = AppSettingsSchema.parse({})
    expect(settings.localWhisper).toEqual({
      serverExe: '',
      modelPath: '',
      port: 8123,
      threads: 4,
      language: 'auto',
      autoStart: true
    })
  })

  it('rejects invalid ports and thread counts', () => {
    expect(WhisperConfigureRequestSchema.safeParse({ port: 80 }).success).toBe(false)
    expect(WhisperConfigureRequestSchema.safeParse({ port: 70000 }).success).toBe(false)
    expect(WhisperConfigureRequestSchema.safeParse({ threads: 0 }).success).toBe(false)
    expect(WhisperConfigureRequestSchema.safeParse({ threads: 4 }).success).toBe(true)
  })
})
