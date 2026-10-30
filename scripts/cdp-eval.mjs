/**
 * CDP eval helper for REAL end-to-end testing of the running app.
 *
 * Usage: node scripts/cdp-eval.mjs "<js expression>" [--port 9223]
 * Launch the app with:  npx electron . --remote-debugging-port=9223
 *
 * Evaluates the expression in the renderer with awaitPromise and prints the
 * JSON value. Used by the audio verification procedures in
 * docs/full-functionality-audit.md — the app itself is never modified.
 */
const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 9223
const expression = portIdx !== -1 ? argv.filter((_, i) => i !== portIdx && i !== portIdx + 1).join(' ') : argv.join(' ')

if (!expression) {
  console.error('usage: node scripts/cdp-eval.mjs "<expression>" [--port 9223]')
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html|ELECTRON_RENDERER_URL/.test(t.url + t.title)) ?? list.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target found', JSON.stringify(list, null, 2))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.rej(new Error(JSON.stringify(m.error)))
    else p.res(m.result)
  }
}
ws.onopen = () => undefined
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('websocket error'))
})

const send = (method, params) => {
  const id = ++msgId
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
})
if (result.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(result.result?.value ?? null, null, 2))
ws.close()
process.exit(0)
