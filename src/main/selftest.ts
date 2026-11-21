/**
 * Optional self-test hooks (no GUI needed):
 *   COPILOT_SELFTEST=screen          electron .   real capture + dedup metrics
 *   COPILOT_SELFTEST=provider-setup  electron .   COPILOT_KEY_FILE=<path> holds
 *       the API key on its first line; writes the settings row + an
 *       OS-encrypted credential, lists available models. The key file is
 *       never logged and should be deleted by the caller afterwards.
 *   COPILOT_SELFTEST=provider-verify electron .   runs connection, streaming,
 *       cancellation, a REAL vision pass, and interview/meeting generations
 *       through the real adapters; prints one JSON result object.
 */
import { ElectronScreenBackend } from './services/screen/screen-backend'
import { averageHash, HashRing, DUPLICATE_SIMILARITY_THRESHOLD } from './services/screen/image-hash'
import * as nodeFs from 'node:fs'
import { OpenAICompatibleProvider } from './services/providers/openai-compatible'
import { CredentialStore } from './services/credential-store'
import { SettingsStore } from './services/settings-store'
import { interviewSystemPrompt, meetingSummaryPrompt, renderModeContextBlock } from './services/modes/prompts'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/'

export async function runScreenSelfTest(): Promise<void> {
  const backend = new ElectronScreenBackend()
  const ring = new HashRing(8)

  const captureOnce = async (label: string): Promise<void> => {
    const t0 = performance.now()
    const captured = await backend.capture('screen', undefined)
    const captureMs = performance.now() - t0

    const t1 = performance.now()
    const hash = averageHash(captured.image)
    const similarity = ring.bestSimilarity(hash)
    ring.push(hash)
    const duplicate = similarity >= DUPLICATE_SIMILARITY_THRESHOLD
    const hashMs = performance.now() - t1

    const encodeMs0 = performance.now()
    const jpegBytes = backend.encode(captured.image).length * 0.75
    const encodeMs = performance.now() - encodeMs0

    const line = {
      label,
      captureMs: Math.round(captureMs),
      hashAndDedupMs: Math.round(hashMs * 100) / 100,
      encodeMs: Math.round(encodeMs),
      width: captured.width,
      height: captured.height,
      jpegKB: Math.round(jpegBytes / 1024),
      similarityToPrevious: Math.round(similarity * 1000) / 1000,
      duplicate,
      rssMB: Math.round(process.memoryUsage().rss / 1048576)
    }
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify(line))
  }

  await captureOnce('first')
  await captureOnce('second') // near-identical screen → should flag duplicate
  // eslint-disable-next-line no-console
  console.log('[selftest] done: 2 captures')
}

export async function runProviderSetup(): Promise<void> {
  const keyFile = process.env['COPILOT_KEY_FILE']
  if (!keyFile) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'setup', ok: false, message: 'COPILOT_KEY_FILE not set' }))
    process.exit(2)
  }
  const apiKey = nodeFs.readFileSync(keyFile, 'utf-8').split(/\r?\n/)[0].trim()
  const electron = (await import('electron')) as typeof import('electron')
  const userData = electron.app.getPath('userData')
  const creds = new CredentialStore(userData + '/credentials.json', electron.safeStorage)
  const settings = new SettingsStore(userData + '/settings.json')

  const probe = new OpenAICompatibleProvider({
    id: 'gemini', label: 'Google Gemini', baseUrl: GEMINI_BASE, apiKey, model: 'gemini-2.0-flash', vision: true
  })
  const test = await probe.testConnection()
  let models: string[] = []
  try {
    const res = await fetch(GEMINI_BASE + 'models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    models = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'models', ok: false, message: String(err).slice(0, 120) }))
  }
  // Candidate selection with real validation: the /models list can include
  // retired models (gemini-2.5-flash is 404 "no longer available to new
  // users"), so each candidate gets a tiny live chat probe first.
  const bare = models.map((m) => m.replace(/^models\//, ''))
  const preferred = process.env['COPILOT_MODEL'] ? [process.env['COPILOT_MODEL']] : []
  const candidates = [
    ...preferred,
    ...bare.filter((m) => m.includes('flash') && !m.includes('thinking') && !m.includes('image') && !m.includes('tts') && !m.includes('omni'))
  ].slice(0, 8)
  let chosen = ''
  let probeStatus = 0
  for (const candidate of candidates) {
    try {
      const r = await fetch(GEMINI_BASE + 'chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: candidate,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 10
        }),
        signal: AbortSignal.timeout(30_000)
      })
      if (r.ok) {
        chosen = candidate
        probeStatus = r.status
        break
      }
    } catch {
      /* try next candidate */
    }
  }
  if (!chosen) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'setup', ok: false, message: 'no working chat model among candidates' }))
    process.exit(1)
  }

  const s = settings.get()
  const existing = s.providers.find((p) => p.id === 'gemini')
  if (existing) {
    existing.model = chosen
    existing.vision = true
    existing.enabled = true
    existing.baseUrl = GEMINI_BASE
  } else {
    s.providers.push({
      id: 'gemini', label: 'Google Gemini', kind: 'openai-compatible',
      baseUrl: GEMINI_BASE, model: chosen, enabled: true, vision: true
    })
  }
  s.activeProviderId = 'gemini'
  settings.set(s)
  creds.set('gemini', apiKey)

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify({
    step: 'setup', ok: test.ok, testMessage: test.message, testLatencyMs: test.latencyMs,
    model: chosen, probeStatus, modelsListed: models.length, keyStoredEncrypted: creds.has('gemini')
  }))
  process.exit(test.ok ? 0 : 1)
}

export async function runProviderVerify(): Promise<void> {
  // Hard watchdog: never hang the harness.
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'verify', ok: false, message: 'watchdog timeout (240s)' }))
    process.exit(3)
  }, 240_000).unref?.()
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step, ...extra }))
  }
  const electron = (await import('electron')) as typeof import('electron')
  const userData = electron.app.getPath('userData')
  const creds = new CredentialStore(userData + '/credentials.json', electron.safeStorage)
  const settings = new SettingsStore(userData + '/settings.json')
  const row = settings.get().providers.find((p) => p.id === 'gemini')
  const apiKey = creds.get('gemini') ?? ''
  if (!row || !apiKey) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'verify', ok: false, message: 'run provider-setup first' }))
    process.exit(2)
  }
  const provider = new OpenAICompatibleProvider({
    id: 'gemini', label: 'Google Gemini', baseUrl: row.baseUrl, apiKey, model: row.model, vision: true
  })
  const out: Record<string, unknown> = { model: row.model }

  const conn = await provider.testConnection()
  out['connection'] = conn
  log('connection', { ok: conn.ok, latencyMs: conn.latencyMs })

  const t0 = performance.now()
  let ttft: number | null = null
  let text = ''
  for await (const chunk of provider.chatStream({
    model: row.model,
    messages: [{ role: 'user', content: 'Reply with exactly: PROVIDER_OK' }],
    maxTokens: 20,
    timeoutMs: 45_000
  })) {
    if (chunk.type === 'delta') {
      if (ttft === null) ttft = Math.round(performance.now() - t0)
      text += chunk.text
    }
  }
  out['chat'] = { ttftMs: ttft, totalMs: Math.round(performance.now() - t0), text: text.trim().slice(0, 80) }
  log('chat', out['chat'] as Record<string, unknown>)

  const cancelController = new AbortController()
  let cancelledCleanly = false
  try {
    for await (const chunk of provider.chatStream({
      model: row.model,
      messages: [{ role: 'user', content: 'Count from 1 to 200.' }],
      signal: cancelController.signal,
      maxTokens: 500,
      timeoutMs: 45_000
    })) {
      if (chunk.type === 'delta') cancelController.abort()
    }
  } catch {
    cancelledCleanly = cancelController.signal.aborted // any abort rejection counts
  }
  out['cancel'] = { ok: cancelledCleanly }
  log('cancel', out['cancel'] as Record<string, unknown>)

  try {
    log('vision-capture-start')
    const backend = new ElectronScreenBackend()
    const captured = await backend.capture('screen', undefined)
    log('vision-captured', { kb: Math.round(captured.jpegBase64.length / 1024) })
    const t1 = performance.now()
    let vttft: number | null = null
    let vtext = ''
    for await (const chunk of provider.chatStream({
      model: row.model,
      messages: [
        { role: 'system', content: 'Describe what is on screen in one short sentence.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is on this screen?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + captured.jpegBase64 } }
          ]
        }
      ],
      timeoutMs: 120_000
    })) {
      if (chunk.type === 'delta') {
        if (vttft === null) vttft = Math.round(performance.now() - t1)
        vtext += chunk.text
      }
    }
    out['vision'] = {
      ttftMs: vttft,
      totalMs: Math.round(performance.now() - t1),
      imageSize: captured.jpegBase64.length,
      response: vtext.trim().slice(0, 300)
    }
  } catch (err) {
    out['vision'] = { ok: false, message: String(err).slice(0, 200) }
  }

  try {
    const t2 = performance.now()
    let itext = ''
    for await (const chunk of provider.chatStream({
      model: row.model,
      messages: [
        { role: 'system', content: interviewSystemPrompt('star', 'none') },
        {
          role: 'user',
          content:
            'Question: Tell me about a time you led a team of fifty engineers.\n\n' +
            renderModeContextBlock([])
        }
      ],
      timeoutMs: 120_000
    })) {
      if (chunk.type === 'delta') itext += chunk.text
    }
    out['interview'] = {
      totalMs: Math.round(performance.now() - t2),
      mentionsMissingDetails: /\[Missing details|general/i.test(itext),
      response: itext.trim().slice(0, 300)
    }
  } catch (err) {
    out['interview'] = { ok: false, message: String(err).slice(0, 200) }
  }

  try {
    const transcript =
      'Session transcript: [0] We agreed to migrate the billing service to Rust. ' +
      '[1] Priya will own the migration; deadline is March 15. ' +
      '[2] Someone should update the docs eventually.'
    const t3 = performance.now()
    let mtext = ''
    for await (const chunk of provider.chatStream({
      model: row.model,
      messages: [
        { role: 'system', content: meetingSummaryPrompt() },
        {
          role: 'user',
          content: renderModeContextBlock([
            { type: 'transcript', displayName: 'Live transcript', text: transcript }
          ])
        }
      ],
      timeoutMs: 120_000
    })) {
      if (chunk.type === 'delta') mtext += chunk.text
    }
    out['meeting'] = {
      totalMs: Math.round(performance.now() - t3),
      hasNotStatedMarker: mtext.includes('(not stated)'),
      mentionsPriya: mtext.includes('Priya'),
      response: mtext.trim().slice(0, 1_400)
    }
  } catch (err) {
    out['meeting'] = { ok: false, message: String(err).slice(0, 200) }
  }

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify({ step: 'verify-final', ok: true, ...out }))
  process.exit(0)
}

export async function runProviderProbe(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const userData = electron.app.getPath('userData')
  const creds = new CredentialStore(userData + '/credentials.json', electron.safeStorage)
  const apiKey = creds.get('gemini') ?? ''
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ step: 'probe', ok: false, message: 'no stored key' }))
    process.exit(2)
  }
  const res = await fetch(GEMINI_BASE + 'models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(15_000)
  })
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (body.data ?? []).map((m) => (m.id ?? '').replace(/^models\//, '')).filter(Boolean)
  const candidates = ids.filter((m) => m.includes('flash') && !m.includes('thinking') && !m.includes('image') && !m.includes('lite')).slice(0, 6)
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify({ step: 'probe-models', count: ids.length, candidates }))
  for (const model of candidates) {
    try {
      const r = await fetch(GEMINI_BASE + 'chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 10
        }),
        signal: AbortSignal.timeout(30_000)
      })
      const text = (await r.text()).slice(0, 160)
      // eslint-disable-next-line no-console
      console.log('[selftest]', JSON.stringify({ step: 'probe', model, status: r.status, body: text }))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[selftest]', JSON.stringify({ step: 'probe', model, error: String(err).slice(0, 120) }))
    }
  }
  process.exit(0)
}

export async function runProviderRaw(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const userData = electron.app.getPath('userData')
  const creds = new CredentialStore(userData + '/credentials.json', electron.safeStorage)
  const settings = new SettingsStore(userData + '/settings.json')
  const row = settings.get().providers.find((p) => p.id === 'gemini')
  const apiKey = creds.get('gemini') ?? ''
  if (!row || !apiKey) process.exit(2)
  const res = await fetch(row.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: row.model,
      messages: [{ role: 'user', content: 'Reply with exactly: PROVIDER_OK' }],
      stream: true
    }),
    signal: AbortSignal.timeout(90_000)
  })
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify({ step: 'raw-status', status: res.status }))
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || n > 14) break
    // eslint-disable-next-line no-console
    console.log('[sse]', decoder.decode(value, { stream: true }).slice(0, 400))
    n += 1
  }
  process.exit(0)
}

/** Phase 3: reproduce the intermittent empty completion; dump raw SSE shape. */
export async function runEmptyProbe(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const userData = electron.app.getPath('userData')
  const creds = new CredentialStore(userData + '/credentials.json', electron.safeStorage)
  const settings = new SettingsStore(userData + '/settings.json')
  const row = settings.get().providers.find((p) => p.id === 'gemini')
  const apiKey = creds.get('gemini') ?? ''
  if (!row || !apiKey) process.exit(2)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(row.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: row.model,
        messages: [{ role: 'user', content: 'Reply with exactly: PROVIDER_OK' }],
        stream: true
      }),
      signal: AbortSignal.timeout(60_000)
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let sawContent = ''
    let finishReason = ''
    let chunkShapes: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const raw = decoder.decode(value, { stream: true })
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue
        try {
          const j = JSON.parse(line.slice(5).trim())
          const delta = j.choices?.[0]?.delta ?? {}
          const keys = Object.keys(delta).sort().join('+')
          if (chunkShapes.length < 6) chunkShapes.push(keys)
          if (typeof delta.content === 'string') sawContent += delta.content
          if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason
        } catch { /* keep-alive */ }
      }
    }
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({
      attempt, status: res.status, contentChars: sawContent.length,
      sample: sawContent.slice(0, 40), finishReason, chunkShapes
    }))
    await new Promise((r) => setTimeout(r, 1_500))
  }
  process.exit(0)
}

/**
 * Phase 6 verification: does Windows actually exclude the overlay from
 * capture? Creates a solid-magenta probe window, captures the screen once
 * with exclusion cleared and once applied, and reports the measured magenta
 * share. Privacy is only claimed when the pixels really disappear AND the OS
 * echoes WDA_EXCLUDEFROMCAPTURE.
 */
export async function runOverlaySelfTest(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const { WindowsCaptureExclusion } = await import('./services/overlay/display-affinity')
  const exclusion = new WindowsCaptureExclusion()
  const backend = new ElectronScreenBackend()

  const probe = new electron.BrowserWindow({
    width: 320,
    height: 240,
    x: 80,
    y: 80,
    frame: false,
    show: true,
    backgroundColor: '#FF00FF',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  await probe.loadURL('data:text/html,<body style="margin:0;background:%23FF00FF"></body>')
  await new Promise((r) => setTimeout(r, 500))

  const magentaShare = (img: { rgba: Uint8Array; width: number; height: number }): number => {
    let hits = 0
    const total = img.width * img.height
    for (let i = 0; i < img.rgba.length; i += 4) {
      const r = img.rgba[i]
      const g = img.rgba[i + 1]
      const b = img.rgba[i + 2]
      if (r > 190 && g < 90 && b > 190) hits += 1
    }
    return total > 0 ? hits / total : 0
  }

  const capture = async (): Promise<{ share: number; width: number; height: number }> => {
    const c = await backend.capture('screen', undefined)
    return { share: magentaShare(c.image), width: c.image.width, height: c.image.height }
  }

  const round = (n: number): number => Math.round(n * 100000) / 100000
  const handle = (): Buffer => probe.getNativeWindowHandle()

  const cleared = exclusion.apply(handle(), false)
  await new Promise((r) => setTimeout(r, 400))
  const capturable = await capture()

  const applied = exclusion.apply(handle(), true)
  await new Promise((r) => setTimeout(r, 400))
  const excluded = await capture()

  const report = {
    support: exclusion.support,
    supportMessage: exclusion.supportMessage,
    clearOk: cleared.ok,
    affinityCapturable: cleared.affinity,
    applyOk: applied.ok,
    affinityExcluded: applied.affinity,
    osConfirmsExclusion: applied.affinity === 0x11,
    magentaShareCapturable: round(capturable.share),
    magentaShareExcluded: round(excluded.share),
    captureSize: `${capturable.width}x${capturable.height}`,
    // The probe must be clearly visible when capturable and must largely
    // vanish when excluded. Thresholds are deliberately conservative.
    probeVisibleWhenCapturable: capturable.share > 0.004,
    probeHiddenWhenExcluded: excluded.share < capturable.share / 4
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))

  probe.destroy()
}

/**
 * Phase 6 integration check: does the real overlay window load its production
 * document, mount the React view through the sandboxed preload, and receive
 * the OS-confirmed capture exclusion? Uses the same OverlayController the app
 * uses; no mocks of the window lifecycle.
 */
export async function runOverlayWindowSelfTest(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const path = await import('node:path')
  const { OverlayController } = await import('./overlay-window')

  const tmp = nodeFs.mkdtempSync(path.join(electron.app.getPath('temp'), 'copilot-ovl-'))
  let settings: import('../shared/protocol').OverlaySettings = {
    enabled: false,
    captureExcluded: true,
    opacity: 0.9,
    fontSize: 15,
    showCaptions: true
  }
  const states: unknown[] = []
  const controller = new OverlayController({
    userDataDir: tmp,
    preloadPath: path.join(__dirname, '../preload/index.js'),
    devUrl: null,
    overlayHtml: path.join(__dirname, '../renderer/overlay.html'),
    getSettings: () => settings,
    persist: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    },
    onStateChange: (s) => states.push(s)
  })

  const state = controller.set({ enabled: true })
  // The isolated harness registers the one channel the overlay renderer asks
  // for on mount; the real app registers it in registerIpcHandlers.
  electron.ipcMain.handle('overlay:get-state', () => controller.getState())
  const win = electron.BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Copilot Overlay')

  // Poll briefly for the renderer to mount.
  let mounted = 0
  let barText = ''
  for (let i = 0; i < 40; i += 1) {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
      try {
        mounted = await win.webContents.executeJavaScript(
          'document.querySelectorAll(".ov-bar").length'
        )
        if (mounted > 0) {
          barText = await win.webContents.executeJavaScript(
            'document.querySelector(".ov-state")?.textContent ?? ""'
          )
          break
        }
      } catch {
        /* keep polling */
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  controller.push({ kind: 'answer', text: 'Overlay content pipeline check', question: 'Self-test' })
  await new Promise((r) => setTimeout(r, 600))
  let answerText = ''
  if (win && !win.isDestroyed()) {
    answerText = await win.webContents.executeJavaScript(
      'document.querySelector(".ov-text")?.textContent ?? ""'
    )
  }

  const report = {
    windowCreated: Boolean(win),
    windowVisible: win ? win.isVisible() : false,
    alwaysOnTop: win ? win.isAlwaysOnTop() : false,
    reactMounted: mounted > 0,
    statusText: barText,
    statusShowsExclusion: barText.includes('excluded from capture'),
    contentRendered: answerText.includes('Overlay content pipeline check'),
    affinity: state.affinity,
    exclusionActive: state.exclusionActive,
    stateEvents: states.length
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))

  controller.dispose()
  try {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** Minimal 16-bit PCM WAV reader (only what the sample needs). */
function readWavPcm16(bytes: Buffer): Int16Array {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file')
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'data') {
      const samples = Math.floor(Math.min(size, bytes.length - body) / 2)
      const pcm = new Int16Array(samples)
      for (let i = 0; i < samples; i += 1) pcm[i] = bytes.readInt16LE(body + i * 2)
      return pcm
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk')
}

/**
 * Phase 1 verification: drive the managed whisper.cpp server through the real
 * adapter with a real WAV and assert the transcript. Proves the child process,
 * the /inference contract and the PCM path together.
 */
export async function runWhisperSelfTest(): Promise<void> {
  const path = await import('node:path')
  const { detectWhisperInstalls, LocalWhisperManager, LocalWhisperStt } = await import(
    './services/stt/local-whisper'
  )

  const candidates = detectWhisperInstalls()
  const chosen = candidates[0]
  if (!chosen) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ ok: false, message: 'no whisper.cpp install detected' }))
    return
  }

  let settings = {
    serverExe: chosen.serverExe,
    modelPath: chosen.modelPath,
    port: 8137,
    threads: 4,
    language: 'auto',
    autoStart: true
  }
  const manager = new LocalWhisperManager(() => settings)

  const t0 = Date.now()
  const started = await manager.ensureStarted()
  const startMs = Date.now() - t0

  const report: Record<string, unknown> = {
    candidates: candidates.length,
    modelSize: chosen.modelSize,
    startOk: started.ok,
    startMessage: started.message,
    startMs
  }

  if (started.ok) {
    const sample = process.env['WHISPER_SAMPLE'] ?? path.join(chosen.source, 'samples', 'jfk.wav')
    try {
      const pcm = readWavPcm16(nodeFs.readFileSync(sample))
      const adapter = new LocalWhisperStt(manager, 'en')
      const t1 = Date.now()
      const result = await adapter.transcribe({ pcm })
      report.transcribeMs = Date.now() - t1
      report.sampleSeconds = Math.round((pcm.length / 16_000) * 10) / 10
      report.text = result.text.slice(0, 200)
      report.textMatches = /ask not what your country/i.test(result.text)
      report.nonEmpty = result.text.length > 0
    } catch (err) {
      report.transcribeError = err instanceof Error ? err.message : String(err)
    }
    const status = manager.status(true)
    report.phaseAfter = status.phase
    report.pid = status.pid
    report.logLines = status.logTail.length
  }

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
  manager.dispose()
}

/**
 * Phase 4 verification: translate real text through a real provider. Uses the
 * local Ollama runtime when it is up (no API key needed), and also exercises
 * the live-segment pipeline (observeSegment -> onResult) end to end.
 */
export async function runTranslationSelfTest(): Promise<void> {
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')
  const { TranslationService } = await import('./services/translation/translation-service')

  const baseUrl = process.env['COPILOT_TRANSLATE_BASEURL'] ?? 'http://127.0.0.1:11434/v1'
  const model = process.env['COPILOT_TRANSLATE_MODEL'] ?? 'qwen2.5:1.5b'
  const provider = new OpenAICompatibleProvider({
    id: 'selftest-ollama',
    label: 'Ollama (self-test)',
    baseUrl,
    apiKey: '',
    model,
    vision: false
  })

  const settings = { enabled: true, targetLanguage: 'es', showOriginal: true, fontSize: 15 }
  const service = new TranslationService({
    resolveProvider: () => ({ provider, model }),
    getSettings: () => settings
  })

  const source = 'Good morning. I led a team of four engineers and reduced build times by forty percent.'
  const t0 = Date.now()
  const direct = await service.translate(source)
  const directMs = Date.now() - t0

  // Live pipeline: a finalized segment must produce exactly one result event.
  const events: Array<Record<string, unknown>> = []
  service.bindEvents({
    onResult: (e) => events.push({ kind: 'result', text: e.translated, provider: e.providerLabel }),
    onError: (e) => events.push({ kind: 'error', message: e.message })
  })
  service.observeSegment({
    sessionId: 'selftest-session',
    segmentId: 'seg-1',
    text: 'You should be concise when you answer.'
  })
  const deadline = Date.now() + 60_000
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  const report = {
    baseUrl,
    model,
    ok: direct.ok,
    translated: direct.text.slice(0, 200),
    providerLabel: direct.providerLabel,
    latencyMs: directMs,
    error: direct.ok ? undefined : direct.message,
    liveEventCount: events.length,
    liveEvents: events,
    stats: service.stats()
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
  service.reset(null)
}
