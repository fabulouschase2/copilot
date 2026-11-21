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

/**
 * Phase 2 verification: draft a story from confirmed facts with a real model,
 * then save it through the service and read it back. The draft must be built
 * from the facts only — no invented employers or numbers.
 */
export async function runStorySelfTest(): Promise<void> {
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')
  const { StoryBankService } = await import('./services/stories/story-service')

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

  const facts = [
    'Led a team of four engineers on a payments platform',
    'Reduced CI build times by 40 percent by caching dependencies and sharding tests',
    'Migrated 12 services from JavaScript to TypeScript'
  ]
  const rows = new Map<string, import('./services/context/sqlite-store').StoryRecord>()
  const service = new StoryBankService({
    store: {
      listStories: (profileId) => [...rows.values()].filter((s) => !profileId || s.profileId === profileId),
      getStory: (id) => rows.get(id) ?? null,
      saveStory: (s) => rows.set(s.storyId, s),
      deleteStory: (id) => rows.delete(id)
    },
    getProfileId: () => 'default',
    getFacts: () => facts,
    resolveProvider: () => ({ provider, model }),
    idFactory: () => 'story-selftest'
  })

  const t0 = Date.now()
  const draft = await service.draft({ framework: 'star', focus: 'delivery impact' })
  const draftMs = Date.now() - t0

  let saved: unknown = null
  let ranked: unknown = null
  if (draft.ok && draft.draft) {
    saved = service.upsert({ ...draft.draft, storyId: undefined })
    ranked = service.retrieve('Tell me about improving engineering delivery').map((h) => ({
      sourceId: h.sourceId,
      score: h.score,
      reason: h.reason
    }))
  }

  const report = {
    baseUrl,
    model,
    draftOk: draft.ok,
    draftMs,
    providerLabel: draft.providerLabel,
    error: draft.ok ? undefined : draft.message,
    draft: draft.draft
      ? {
          title: draft.draft.title,
          situation: draft.draft.situation.slice(0, 160),
          task: draft.draft.task.slice(0, 160),
          action: draft.draft.action.slice(0, 200),
          result: draft.draft.result.slice(0, 160),
          skills: draft.draft.skills
        }
      : undefined,
    saveOk: (saved as { ok?: boolean } | null)?.ok ?? false,
    storedCount: rows.size,
    ranked
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
}

/**
 * UI smoke test: loads the real built renderer with the real preload and clicks
 * through every navigation view, collecting renderer console errors. Stubs only
 * the IPC reads that run on mount, so the React tree itself is the real thing.
 */
export async function runUiSelfTest(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const { AppSettingsSchema } = await import('../shared/protocol')
  const { createMainWindow } = await import('./window')

  const settings = AppSettingsSchema.parse({})
  const overlayState = {
    enabled: false,
    visible: false,
    captureExcluded: true,
    affinity: null,
    exclusionActive: false,
    exclusionUnverified: false,
    support: 'supported',
    supportMessage: 'stub',
    opacity: 0.94,
    fontSize: 15,
    showCaptions: true,
    error: null,
    lastErrorCode: null
  }
  const whisperState = {
    phase: 'stopped',
    port: 8123,
    baseUrl: 'http://127.0.0.1:8123',
    serverExe: '',
    modelPath: '',
    serverExePresent: false,
    modelPresent: false,
    pid: null,
    message: 'not configured',
    lastError: null,
    logTail: [],
    activeAsStt: false
  }

  electron.ipcMain.handle('settings:get', () => settings)
  electron.ipcMain.handle('settings:set', () => settings)
  electron.ipcMain.handle('overlay:get-state', () => overlayState)
  electron.ipcMain.handle('overlay:set', () => overlayState)
  electron.ipcMain.handle('stories:list', () => ({ stories: [] }))
  electron.ipcMain.handle('context:list', () => ({
    sources: [],
    session: { id: null, transcriptItems: 0, screenItems: 0 }
  }))
  electron.ipcMain.handle('context:persistence-status', () => ({
    kind: 'sqlite',
    schemaVersion: 4,
    counts: { documents: 0, facts: 0, meetings: 0, practiceSessions: 0 },
    migration: null,
    lastBackupAt: null,
    backupsAvailable: 0
  }))
  electron.ipcMain.handle('profiles:list', () => ({ profiles: [] }))
  electron.ipcMain.handle('practice:list', () => ({ sessions: [] }))
  electron.ipcMain.handle('meetings:list', () => ({ meetings: [] }))
  electron.ipcMain.handle('providers:list', () => ({ providers: [] }))
  electron.ipcMain.handle('providers:routes', () => ({ routes: [], cloudBlockedReason: null }))
  electron.ipcMain.handle('conversations:list', () => ({ conversations: [] }))
  electron.ipcMain.handle('conversations:create', () => ({ ok: false, message: 'stub' }))
  electron.ipcMain.handle('stt:providers-list', () => ({ providers: [] }))
  electron.ipcMain.handle('whisper:status', () => whisperState)
  electron.ipcMain.handle('audio:diagnostics', () => ({
    configuredSource: 'mic',
    stt: { label: null, kind: null, language: null, cloudOrLocal: 'none', hasCredential: false },
    permissions: { mediaArmed: false, displayCaptureArmed: false },
    session: null,
    lastSegmentAt: null,
    lastError: null
  }))

  const win = createMainWindow()
  const consoleErrors: string[] = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(String(message).slice(0, 300))
  })

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
  })
  // Let React mount and run its effects.
  await new Promise((r) => setTimeout(r, 1_500))

  const navLabels: string[] = await win.webContents.executeJavaScript(
    '[...document.querySelectorAll(".nav-btn")].map(b => b.textContent.trim())'
  )
  const shotDir = process.env['COPILOT_SHOT_DIR'] ?? ''
  const shots: string[] = []
  const captureShot = async (name: string): Promise<void> => {
    if (!shotDir) return
    try {
      const path = await import('node:path')
      nodeFs.mkdirSync(shotDir, { recursive: true })
      const img = await win.capturePage()
      const file = path.join(shotDir, `${name}.png`)
      nodeFs.writeFileSync(file, img.toPNG())
      shots.push(file)
    } catch {
      /* screenshots are evidence, never a reason to fail the smoke test */
    }
  }
  const views: Array<{ label: string; rendered: boolean; chars: number }> = []
  for (const label of navLabels) {
    const result = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.nav-btn')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!btn) return { rendered: false, chars: 0 };
      btn.click();
      return new Promise((resolve) => setTimeout(() => {
        const view = document.querySelector('.view');
        resolve({ rendered: Boolean(view), chars: view ? view.textContent.trim().length : 0 });
      }, 350));
    })()`)
    views.push({ label, ...(result as { rendered: boolean; chars: number }) })
    await captureShot(`view-${label.toLowerCase()}`)
  }

  // Settings is reached from the header, not the nav.
  const settingsResult = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Settings'));
    if (!btn) return { rendered: false, chars: 0 };
    btn.click();
    return new Promise((resolve) => setTimeout(() => {
      const view = document.querySelector('.view');
      resolve({ rendered: Boolean(view), chars: view ? view.textContent.trim().length : 0 });
    }, 500));
  })()`)

  const report = {
    navCount: navLabels.length,
    navLabels,
    views,
    settings: settingsResult,
    shots,
    emptyViews: views.filter((v) => v.chars < 20).map((v) => v.label),
    consoleErrors
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
  win.destroy()
}

/**
 * Phase 2 completion verification: extract facts from a résumé with a real
 * model, then prove the two guarantees end to end:
 *   1. every stored fact's quote appears in the document (no fabrication);
 *   2. pending facts are invisible to retrieval until confirmed.
 */
export async function runCareerSelfTest(): Promise<void> {
  const path = await import('node:path')
  const { SQLiteStore } = await import('./services/context/sqlite-store')
  const { ResumeExtractionService, normalizeForMatch } = await import('./services/career/resume-facts')
  const { ContextService } = await import('./services/context/context-service')
  const { ContextEngine } = await import('./services/context-engine')
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')

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

  const docText = [
    'Jordan Avery — Senior Software Engineer',
    'Acme Payments, 2019-2024. Led a team of four engineers on a payments platform.',
    'Reduced CI build times by 40 percent by caching dependencies and sharding tests.',
    'Migrated 12 services from JavaScript to TypeScript.',
    'Skills: TypeScript, Node.js, SQLite, Electron, React.'
  ].join('\n')

  const tmp = nodeFs.mkdtempSync(path.join(await import('electron').then((e) => e.app.getPath('temp')), 'copilot-career-'))
  const store = new SQLiteStore(path.join(tmp, 'context.db'))
  const now = new Date().toISOString()
  store.addDocument({
    sourceId: 'doc-resume',
    displayName: 'resume.txt',
    text: docText,
    status: 'ready',
    createdAt: now,
    updatedAt: now
  })

  const service = new ResumeExtractionService({
    listDocuments: () => store.listDocuments(),
    addFact: (fact) => store.addFact(fact),
    resolveProvider: () => ({ provider, model }),
    getProfileId: () => 'default'
  })

  const t0 = Date.now()
  const result = await service.extractFromDocument('doc-resume')
  const elapsedMs = Date.now() - t0

  const facts = store.listFacts('default')
  const docNorm = normalizeForMatch(docText)
  const quotesAnchored = facts.every((f) => normalizeForMatch(f.sourceText ?? '').length > 0 && docNorm.includes(normalizeForMatch(f.sourceText ?? '')))
  const allPending = facts.every((f) => f.status === 'pending')

  // Confirm exactly one fact and verify retrieval separation.
  let confirmedVisible = false
  let pendingHidden = false
  if (facts.length > 0) {
    store.setFactStatus(facts[0].factId, 'confirmed', new Date().toISOString())
    const ctx = new ContextService({
      store,
      engine: new ContextEngine(),
      settings: () => ({ totalTokenBudget: 1_200, perSourceCharBudget: 1_200, minScore: 0.01 })
    })
    const retrieved = ctx.retrieve('team engineers build times TypeScript', {
      includeDocuments: false,
      includeProfile: true,
      includeSession: false
    })
    const ids = new Set(retrieved.items.map((i) => i.sourceId))
    confirmedVisible = ids.has(facts[0].factId)
    pendingHidden = facts.slice(1).every((f) => !ids.has(f.factId))
  }

  const report = {
    provider: provider.label,
    model,
    ok: result.ok,
    added: result.added,
    rejected: result.rejected.length,
    rejectedReasons: result.rejected.slice(0, 3).map((r) => r.reason),
    elapsedMs,
    stored: facts.length,
    allPending,
    quotesAnchored,
    confirmedVisible,
    pendingHidden,
    message: result.message
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))

  store.close()
  try {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Task 1 verification: does the REAL overlay window stay out of captures?
 *
 * Paints the overlay magenta through its own renderer, then measures the
 * magenta share of four capture paths with exclusion off and on:
 *   1. entire screen      — Chromium desktopCapturer (what Meet/Chrome use)
 *   2. window capture     — desktopCapturer window sources
 *   3. legacy GDI BitBlt  — PowerShell CopyFromScreen (older recorders)
 *   4. PrintWindow        — the API many "window capture" tools call
 *
 * Everything is reported per path; a path that cannot run is reported as such.
 */
export async function runPrivacySelfTest(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const path = await import('node:path')
  const { OverlayController } = await import('./overlay-window')
  const { execFile } = await import('node:child_process')

  const tmp = nodeFs.mkdtempSync(path.join(electron.app.getPath('temp'), 'copilot-priv-'))
  let settings: import('../shared/protocol').OverlaySettings = {
    enabled: false,
    captureExcluded: false,
    opacity: 1,
    fontSize: 15,
    showCaptions: true
  }
  const controller = new OverlayController({
    userDataDir: tmp,
    preloadPath: path.join(__dirname, '../preload/index.js'),
    devUrl: null,
    overlayHtml: path.join(__dirname, '../renderer/overlay.html'),
    getSettings: () => settings,
    persist: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    }
  })
  electron.ipcMain.handle('overlay:get-state', () => controller.getState())

  controller.set({ enabled: true })
  const win = electron.BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Copilot Overlay')
  if (!win) {
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ ok: false, message: 'overlay window was not created' }))
    controller.dispose()
    return
  }

  // Opaque control window: proves the screen-capture path works at all.
  const probe = new electron.BrowserWindow({
    width: 240,
    height: 120,
    x: 40,
    y: 40,
    frame: false,
    show: true,
    backgroundColor: '#00FF00',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  await probe.loadURL('data:text/html,<body style="margin:0;background:%2300FF00"></body>')
  await new Promise((r) => setTimeout(r, 500))

  // Wait for the document, then paint it magenta so pixels are unambiguous.
  for (let i = 0; i < 40 && win.webContents.isLoading(); i += 1) {
    await new Promise((r) => setTimeout(r, 150))
  }
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.style.background = '#FF00FF';
    document.body.style.background = '#FF00FF';
    const root = document.querySelector('.overlay');
    if (root) { root.style.background = '#FF00FF'; root.style.boxShadow = 'none'; }
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  /** Magenta share of a nativeImage (BGRA bitmap). */
  const colorShare = (
    img: Electron.NativeImage,
    test: (r: number, g: number, b: number) => boolean
  ): number => {
    if (img.isEmpty()) return 0
    const size = img.getSize()
    const bgra = img.toBitmap()
    const total = size.width * size.height
    if (total === 0) return 0
    let hits = 0
    for (let i = 0; i < bgra.length; i += 4) {
      const b = bgra[i]
      const g = bgra[i + 1]
      const r = bgra[i + 2]
      if (test(r, g, b)) hits += 1
    }
    return hits / total
  }
  const magentaShare = (img: Electron.NativeImage): number =>
    colorShare(img, (r, g, b) => r > 190 && g < 90 && b > 190)

  const round = (n: number): number => Math.round(n * 100000) / 100000

  const captureScreenShare = async (): Promise<{ share: number; count: number; perSource: number[] }> => {
    const sources = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    })
    const usable = sources.filter((s) => !s.thumbnail.isEmpty())
    const perSource = usable.map((s) => round(magentaShare(s.thumbnail)))
    return { share: perSource.length > 0 ? Math.max(...perSource) : 0, count: usable.length, perSource }
  }

  const captureWindowShare = async (): Promise<{ share: number; listed: boolean }> => {
    const sources = await electron.desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 720, height: 240 }
    })
    const source = sources.find((s) => s.name.includes('Copilot Overlay'))
    if (!source) return { share: 0, listed: false }
    return { share: magentaShare(source.thumbnail), listed: true }
  }

  /** Legacy GDI BitBlt capture through PowerShell + System.Drawing. */
  const gdiCaptureTo = async (file: string, rect?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    const bounds = rect ?? { x: 0, y: 0, width: 0, height: 0 }
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type -AssemblyName System.Windows.Forms',
      rect
        ? `$x=${bounds.x}; $y=${bounds.y}; $w=${bounds.width}; $h=${bounds.height}`
        : '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x=$b.X; $y=$b.Y; $w=$b.Width; $h=$b.Height',
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)',
      `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $bmp.Dispose()'
    ].join('; ')
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  const gdiShare = async (rect?: { x: number; y: number; width: number; height: number }): Promise<number> => {
    const file = path.join(tmp, `gdi-${Date.now()}.png`)
    await gdiCaptureTo(file, rect)
    const share = magentaShare(electron.nativeImage.createFromPath(file))
    try {
      nodeFs.unlinkSync(file)
    } catch {
      /* best-effort */
    }
    return share
  }

  /** PrintWindow capture of the overlay's own HWND. */
  const printWindowShare = async (): Promise<number> => {
    const file = path.join(tmp, `pw-${Date.now()}.png`)
    const handle = win.getNativeWindowHandle()
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0))
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"',
      'using System; using System.Drawing; using System.Runtime.InteropServices;',
      'public class Cap {',
      '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '  public struct RECT { public int Left, Top, Right, Bottom; }',
      '  public static void Save(long h, string path) {',
      '    RECT r; GetWindowRect(new IntPtr(h), out r);',
      '    int w = Math.Max(1, r.Right - r.Left), hh = Math.Max(1, r.Bottom - r.Top);',
      '    using (var bmp = new Bitmap(w, hh)) using (var g = Graphics.FromImage(bmp)) {',
      '      IntPtr dc = g.GetHdc(); PrintWindow(new IntPtr(h), dc, 2); g.ReleaseHdc(dc);',
      '      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);',
      '    }',
      '  }',
      '}',
      '"@',
      `[Cap]::Save(${hwnd}, '${file.replace(/'/g, "''")}')`
    ].join('\n')
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) =>
        err ? reject(err) : resolve()
      )
    })
    const img = electron.nativeImage.createFromPath(file)
    const share = magentaShare(img)
    try {
      nodeFs.unlinkSync(file)
    } catch {
      /* best-effort */
    }
    return share
  }

  const measure = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {}
    // Control: an opaque window proves the screen-capture path itself works.
    try {
      const pb = probe.getBounds()
      out.opaqueProbeRect = { x: pb.x, y: pb.y, w: pb.width, h: pb.height }
      const file = path.join(tmp, `probe-${Date.now()}.png`)
      await gdiCaptureTo(file, pb)
      out.opaqueProbeShare = round(colorShare(electron.nativeImage.createFromPath(file), (r, g, b) => g > 150 && r < 100 && b < 100))
      nodeFs.unlinkSync(file)
    } catch (err) {
      out.opaqueProbeShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      const screen = await captureScreenShare()
      out.screenShare = round(screen.share)
      out.screenSourceCount = screen.count
      out.screenPerSource = screen.perSource
    } catch (err) {
      out.screenShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      const w = await captureWindowShare()
      out.windowListed = w.listed
      out.windowShare = round(w.share)
    } catch (err) {
      out.windowShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      out.gdiShare = round(await gdiShare())
    } catch (err) {
      out.gdiShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      const b = win.getBounds()
      out.overlayRect = { x: b.x, y: b.y, w: b.width, h: b.height }
      out.gdiOverlayRectShare = round(await gdiShare({ x: b.x, y: b.y, width: b.width, height: b.height }))
    } catch (err) {
      out.gdiOverlayRectShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      out.printWindowShare = round(await printWindowShare())
    } catch (err) {
      out.printWindowShare = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    return out
  }

  const capturable = await measure()
  const applied = controller.set({ captureExcluded: true })
  await new Promise((r) => setTimeout(r, 900))
  const excluded = await measure()

  const report = {
    osConfirmsExclusion: applied.exclusionActive,
    affinity: applied.affinity,
    display: electron.screen.getPrimaryDisplay().bounds,
    capturable,
    excluded,
    screenHidden:
      typeof capturable.screenShare === 'number' && typeof excluded.screenShare === 'number'
        ? (capturable.screenShare as number) > 0.004 &&
          (excluded.screenShare as number) < (capturable.screenShare as number) / 4
        : 'unmeasured',
    windowHidden:
      typeof capturable.windowShare === 'number' && typeof excluded.windowShare === 'number'
        ? (capturable.windowShare as number) > 0.2 && (excluded.windowShare as number) < 0.05
        : 'unmeasured',
    gdiRectHidden:
      typeof capturable.gdiOverlayRectShare === 'number' && typeof excluded.gdiOverlayRectShare === 'number'
        ? (capturable.gdiOverlayRectShare as number) > 0.05 &&
          (excluded.gdiOverlayRectShare as number) < 0.01
        : 'unmeasured',
    // Window-source capture is expected NOT to hide; reported so the limitation
    // is visible rather than implied away.
    windowCaptureStillShowsOverlay:
      typeof capturable.windowShare === 'number' && typeof excluded.windowShare === 'number'
        ? (excluded.windowShare as number) > 0.2
        : 'unmeasured'
  }
  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))

  controller.dispose()
  if (!probe.isDestroyed()) probe.destroy()
  try {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Task 4 verification (no real Gemini key available):
 *  - an invalid key fails with an honest auth message and never leaks the key;
 *  - an unreachable endpoint fails cleanly;
 *  - the local Ollama provider connects with no key (local-only mode);
 *  - switching the active provider takes effect on the next resolution;
 *  - the credential file never contains the key in clear text.
 */
export async function runProviderSelfTest(): Promise<void> {
  const path = await import('node:path')
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')
  const { ProviderRegistry } = await import('./services/provider-registry')
  const { SettingsStore } = await import('./services/settings-store')
  const { CredentialStore } = await import('./services/credential-store')
  const electron = (await import('electron')) as typeof import('electron')
  const { AppSettingsSchema } = await import('../shared/protocol')

  const SECRET = 'TEST-KEY-DO-NOT-LOG-1234567890'
  const geminiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/'
  const model = process.env['COPILOT_GEMINI_MODEL'] ?? 'gemini-2.0-flash'
  const gemini = new OpenAICompatibleProvider({
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: geminiBase,
    apiKey: SECRET,
    model,
    vision: true
  })

  const report: Record<string, unknown> = {}

  const conn = await gemini.testConnection()
  report.geminiTestOk = conn.ok
  report.geminiTestMessage = conn.message
  report.geminiMessageLeaksKey = conn.message.includes(SECRET)

  let chatError = ''
  try {
    for await (const chunk of gemini.chatStream({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: 20_000,
      maxTokens: 8
    })) {
      void chunk
    }
  } catch (err) {
    chatError = err instanceof Error ? err.message : String(err)
  }
  report.geminiChatError = chatError
  report.geminiChatLeaksKey = chatError.includes(SECRET)

  const dead = new OpenAICompatibleProvider({
    id: 'dead',
    label: 'Dead endpoint',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: '',
    model: 'x',
    vision: false
  })
  const deadConn = await dead.testConnection()
  report.unreachableOk = deadConn.ok
  report.unreachableMessage = deadConn.message.slice(0, 120)

  const ollama = new OpenAICompatibleProvider({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: process.env['COPILOT_TRANSLATE_MODEL'] ?? 'qwen2.5:1.5b',
    vision: false
  })
  const ollamaConn = await ollama.testConnection()
  report.ollamaOk = ollamaConn.ok
  report.ollamaLatencyMs = ollamaConn.latencyMs

  const tmp = nodeFs.mkdtempSync(path.join(electron.app.getPath('temp'), 'copilot-prov-'))
  const settings = new SettingsStore(path.join(tmp, 'settings.json'))
  const creds = new CredentialStore(path.join(tmp, 'credentials.json'), electron.safeStorage)
  const withProviders = AppSettingsSchema.parse({
    providers: [
      { id: 'gemini', label: 'Google Gemini', kind: 'openai-compatible', baseUrl: geminiBase, model: 'gemini-2.0-flash', vision: true, enabled: true },
      { id: 'ollama', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:1.5b', vision: false, enabled: true }
    ],
    activeProviderId: 'gemini'
  })
  settings.set(withProviders)
  const registry = new ProviderRegistry(settings, creds)
  const first = registry.resolveActive()
  settings.set({ ...settings.get(), activeProviderId: 'ollama' })
  const second = registry.resolveActive()
  report.switchFirst = first?.provider.label ?? null
  report.switchSecond = second?.provider.label ?? null
  report.switchWorks = first?.provider.label === 'Google Gemini' && second?.provider.label === 'Ollama'
  report.localOnlyResolvesWithoutKey = second !== null && !creds.has('ollama')

  creds.set('gemini', SECRET)
  report.credentialSaved = creds.has('gemini') && creds.get('gemini') === SECRET
  const credFile = path.join(tmp, 'credentials.json')
  const raw = nodeFs.existsSync(credFile) ? nodeFs.readFileSync(credFile, 'utf-8') : ''
  report.credentialFileContainsPlaintext = raw.includes(SECRET)

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))

  try {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * 0.4.0 verification: screen translation end to end, with no cloud key.
 * Renders English text in a window, captures it, runs LOCAL Windows OCR, then
 * translates with the configured provider (Ollama here). Also checks that a
 * blank region is reported as "no readable text" rather than a blank success.
 */
export async function runScreenTranslationSelfTest(): Promise<void> {
  const electron = (await import('electron')) as typeof import('electron')
  const { ElectronScreenBackend, cropImage, cropRect } = await import('./services/screen/screen-backend')
  const { ScreenTranslationService } = await import('./services/screen/screen-translation')
  const { ocrImageFile } = await import('./services/screen/local-ocr')
  const { TranslationService } = await import('./services/translation/translation-service')
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')

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
  const translation = new TranslationService({
    resolveProvider: () => ({ provider, model }),
    getSettings: () => ({ enabled: true, targetLanguage: 'es', showOriginal: true, fontSize: 15 })
  })

  const win = new electron.BrowserWindow({
    width: 900,
    height: 260,
    x: 100,
    y: 80,
    frame: false,
    show: true,
    backgroundColor: '#ffffff',
    title: 'OCR SELFTEST',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  const html = encodeURIComponent(
    '<body style="margin:0;background:#ffffff;color:#111;font:28px Segoe UI;padding:26px">' +
      '<div>Good morning. The meeting starts at nine.</div>' +
      '<div>Please review the quarterly numbers.</div></body>'
  )
  await win.loadURL(`data:text/html;charset=utf-8,${html}`)
  await new Promise((r) => setTimeout(r, 900))

  const sources = await electron.desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 32, height: 32 }
  })
  const source = sources.find((s) => s.name.includes('OCR SELFTEST'))

  const backend = new ElectronScreenBackend()
  const service = new ScreenTranslationService({
    capture: async (sourceId, region) => {
      const kind = sourceId && sourceId.startsWith('window:') ? 'window' : 'screen'
      const cap = await backend.capture(kind, sourceId)
      let image = cap.image
      if (region) {
        const rect = cropRect(image.width, image.height, region)
        if (rect) image = cropImage(image, rect)
      }
      return { jpegBase64: backend.encode(image), width: image.width, height: image.height }
    },
    ocr: (file) => ocrImageFile(file),
    translate: (text, target) => translation.translateDetached(text, undefined, target)
  })

  const report: Record<string, unknown> = {
    windowCaptureAvailable: Boolean(source),
    sourceId: source?.id ?? null
  }

  if (source) {
    const t0 = Date.now()
    const res = await service.translateRegion({ sourceId: source.id, targetLanguage: 'es' })
    report.elapsedMs = Date.now() - t0
    report.ok = res.ok
    report.original = res.original.slice(0, 300)
    report.translated = res.translated.slice(0, 300)
    report.ocrProvider = res.ocrProvider
    report.translateProvider = res.translateProvider
    report.ocrLanguage = res.ocrLanguage
    report.detectedLanguage = res.detectedLanguage
    report.recognisedEnglish = /meeting starts at nine/i.test(res.original)
    report.translatedNonEmpty = res.translated.trim().length > 0
    report.historyCount = service.list().length
    report.message = res.message
  }

  // Blank area must not be reported as a successful translation.
  const blank = await service.translateRegion({
    sourceId: source?.id,
    region: { x: 0, y: 0, w: 0.02, h: 0.02 },
    targetLanguage: 'es'
  })
  report.blankOk = blank.ok
  report.blankMessage = blank.message ?? null

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
  if (!win.isDestroyed()) win.destroy()
}

/**
 * 0.5.0 live Gemini verification.
 *
 * The key is read from the COPILOT_GEMINI_KEY environment variable, never from
 * source, argv or a committed file. It is stored through the app's own
 * CredentialStore (OS-encrypted) and never printed: every logged string is
 * passed through a redactor first.
 *
 * Verifies: model discovery, text generation, and VISION on a real captured
 * window, then writes the working provider row into settings.
 */
export async function runGeminiLiveSelfTest(): Promise<void> {
  try {
    await geminiLiveInner()
  } catch (err) {
    // Never let a harness crash hide the result; redact anything key-shaped.
    const message = (err instanceof Error ? err.message : String(err)).replace(/AQ\.[A-Za-z0-9._-]+/g, '[redacted]')
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ ok: false, fatal: message.slice(0, 300) }))
  }
}

async function geminiLiveInner(): Promise<void> {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const pathMod = await import('node:path')
  const stepFile = pathMod.join(os.tmpdir(), 'copilot-gemini-steps.log')
  try {
    fs.writeFileSync(stepFile, '', 'utf-8')
  } catch {
    /* best-effort */
  }
  const step = (name: string, extra?: unknown): void => {
    try {
      fs.appendFileSync(
        stepFile,
        `${new Date().toISOString()} ${name}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}\n`,
        'utf-8'
      )
    } catch {
      /* best-effort */
    }
  }
  step('start')
  const electron = (await import('electron')) as typeof import('electron')
  const { OpenAICompatibleProvider } = await import('./services/providers/openai-compatible')
  const { SettingsStore } = await import('./services/settings-store')
  const { CredentialStore } = await import('./services/credential-store')
  const { AppSettingsSchema } = await import('../shared/protocol')

  // The app quits when the last window closes; keep one alive so a mid-test
  // window destruction cannot abort the verification.
  const keeper = new electron.BrowserWindow({ show: false, width: 2, height: 2 })
  const key = (process.env['COPILOT_GEMINI_KEY'] ?? '').trim()
  const report: Record<string, unknown> = {}
  if (!key) {
    report.ok = false
    report.message = 'COPILOT_GEMINI_KEY is not set.'
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify(report))
    return
  }
  const redact = (s: string): string => (key ? s.split(key).join('[redacted]') : s)
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/'

  // 1. Discover models with the key (also validates the key itself).
  let modelIds: string[] = []
  try {
    const res = await fetch(`${baseUrl}models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000)
    })
    report.modelsStatus = res.status
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: string }> }
      modelIds = (body.data ?? [])
        .map((m) => String(m.id ?? ''))
        .filter((id) => id.startsWith('models/') || id.length > 0)
        .map((id) => id.replace(/^models\//, ''))
    } else {
      report.modelsError = redact((await res.text()).slice(0, 200))
    }
  } catch (err) {
    report.modelsError = redact(err instanceof Error ? err.message : String(err))
  }
  report.modelCount = modelIds.length
  report.modelsSample = modelIds.slice(0, 8)
  step('models', { status: report.modelsStatus, count: modelIds.length })

  // Model names move fast (2.5-flash was retired for new keys mid-verification),
  // so candidates come from the live model list and are tried until one works.
  const versionOf = (id: string): number => {
    const m = /gemini-(\d+(?:\.\d+)?)/i.exec(id)
    return m ? Number.parseFloat(m[1]) : 0
  }
  const preferred = [
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash'
  ]
  const stable = [...new Set(modelIds)]
    .filter(
      (id) =>
        /^gemini-/i.test(id) &&
        !/tts|image|embedding|aqa|learnlm|native-audio|argon|carbon|hydrogen|neon|live|thinking|exp|preview/i.test(
          id
        )
    )
    .sort((a, b) => {
      const byVersion = versionOf(b) - versionOf(a)
      if (byVersion !== 0) return byVersion
      return Number(/flash/i.test(b)) - Number(/flash/i.test(a))
    })
  const candidates = [
    ...preferred.filter((m) => modelIds.includes(m)),
    ...stable.filter((m) => !preferred.includes(m))
  ].slice(0, 6)
  report.candidates = candidates

  // A fresh provider per attempt: a cancelled stream must not poison the next try.
  const workingProvider = (model: string): InstanceType<typeof OpenAICompatibleProvider> =>
    new OpenAICompatibleProvider({
      id: 'gemini',
      label: 'Google Gemini',
      baseUrl,
      apiKey: key,
      model,
      vision: true
    })

  // 2. Text generation: first candidate that answers wins.
  let chosen = ''
  let text = ''
  const attempts: Array<{ model: string; ok: boolean; error?: string }> = []
  for (const candidate of candidates) {
    // Two attempts per model: the API returns transient 429/503 under load.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t0 = Date.now()
      let candidateText = ''
      try {
        for await (const chunk of workingProvider(candidate).chatStream({
          model: candidate,
          messages: [{ role: 'user', content: 'Reply with exactly: COPILOT OK' }],
          timeoutMs: 60_000,
          maxTokens: 64
        })) {
          if (chunk.type === 'delta') candidateText += chunk.text
        }
        if (candidateText.trim().length > 0) {
          chosen = candidate
          text = candidateText
          attempts.push({ model: candidate, ok: true })
          report.textLatencyMs = Date.now() - t0
          break
        }
        attempts.push({ model: candidate, ok: false, error: 'empty response' })
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err))
        attempts.push({ model: candidate, ok: false, error: message.slice(0, 140) })
        const transient = /429|503|UNAVAILABLE|high demand/i.test(message)
        if (!transient || attempt === 1) break
        await new Promise((r) => setTimeout(r, 1_200))
      }
      if (chosen) break
    }
    if (chosen) break
  }
  report.attempts = attempts
  report.model = chosen || null
  report.textOk = text.trim().length > 0
  if (report.textOk) report.textSample = redact(text.trim().slice(0, 80))
  step('text', { ok: report.textOk, model: chosen })

  // 3. Vision on a real captured window.
  const win = new electron.BrowserWindow({
    width: 820,
    height: 240,
    x: 120,
    y: 120,
    frame: false,
    show: true,
    backgroundColor: '#ffffff',
    title: 'VISION SELFTEST',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  const html = encodeURIComponent(
    '<body style="margin:0;background:#ffffff;color:#111;font:30px Segoe UI;padding:28px">' +
      '<div>QUARTERLY REVENUE: 4.2 MILLION</div>' +
      '<div>Region: EMEA. Status: ON TRACK</div></body>'
  )
  await win.loadURL(`data:text/html;charset=utf-8,${html}`)
  await new Promise((r) => setTimeout(r, 900))
  // Proven capture path (same as the screen-translation test).
  const sources = await electron.desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 900, height: 300 }
  })
  const source = sources.find((s) => s.name.includes('VISION SELFTEST'))
  const jpeg = source ? source.thumbnail.toJPEG(85).toString('base64') : ''
  report.visionSourceFound = Boolean(source)
  if (!win.isDestroyed()) win.destroy()
  step('captured', { found: Boolean(source), bytes: jpeg.length })

  let visionText = ''
  try {
    if (!chosen) throw new Error('no Gemini model answered the text probe')
    for await (const chunk of workingProvider(chosen).chatStream({
      model: chosen,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read the screenshot and state the revenue figure and the status verbatim.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } }
          ]
        }
      ],
      timeoutMs: 90_000,
      maxTokens: 120
    })) {
      if (chunk.type === 'delta') visionText += chunk.text
    }
    report.visionOk = visionText.trim().length > 0
    report.visionSample = redact(visionText.trim().slice(0, 200))
    report.visionSawRevenue = /4\.2/i.test(visionText)
    report.visionSawStatus = /on track/i.test(visionText)
  } catch (err) {
    report.visionOk = false
    report.visionError = redact(err instanceof Error ? err.message : String(err))
  }
  step('vision', { ok: report.visionOk })

  // 4. Persist the working provider + credential through the app's own stores.
  const userData = electron.app.getPath('userData')
  const settings = SettingsStore.forUserData(userData)
  const creds = CredentialStore.forUserData(userData, electron.safeStorage)
  try {
    creds.set('gemini', key)
    const current = settings.get()
    const row = {
      id: 'gemini',
      label: 'Google Gemini',
      kind: 'openai-compatible' as const,
      baseUrl,
      model: chosen || candidates[0] || 'gemini-3.8-flash',
      vision: true,
      enabled: true
    }
    const next = AppSettingsSchema.parse({
      ...current,
      providers: [...current.providers.filter((p) => p.id !== 'gemini'), row],
      activeProviderId: current.activeProviderId ?? 'gemini',
      // Screen analysis is private; the user asked for cloud vision explicitly.
      allowCloudPrivate: true
    })
    settings.set(next)
    report.credentialStored = creds.has('gemini')
    report.providerConfigured = settings.get().providers.some((p) => p.id === 'gemini')
    report.allowCloudPrivate = settings.get().allowCloudPrivate
  } catch (err) {
    report.storeError = redact(err instanceof Error ? err.message : String(err))
  }

  // eslint-disable-next-line no-console
  console.log('[selftest]', JSON.stringify(report))
  if (!keeper.isDestroyed()) keeper.destroy()
}
