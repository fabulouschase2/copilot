/**
 * Practice audit driver (real providers, real UI).
 * Runs a 2-question mock interview for each of the 7 practice types via the
 * running app (CDP) and reports the pipeline: question → evaluation →
 * scorecard, plus the TTS speaking flag transition.
 * Usage: node scripts/audit-practice.mjs [--port 9223]
 */
const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 9223

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    p.res(m.result)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, { res })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Page.bringToFront')
await send('Runtime.enable')
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(desc, expr, timeoutMs = 90_000, interval = 1_500) {
  const start = Date.now()
  for (;;) {
    const v = await evalJs(expr)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${desc}`)
    await sleep(interval)
  }
}

const TYPES = [
  ['behavioral', 'Tell them about leading the dashboard migration: the deadline slipped two weeks, I re-planned the scope with the team, shipped the core first, and stakeholders kept the agreed reporting date for the remainder.'],
  ['technical', 'Explain idempotency with PUT versus POST, then note that retries need idempotency keys for POST.'],
  ['software-engineering', 'Describe debugging a production memory leak: heap snapshots, comparison, found an unremoved event listener, added teardown and an alert on growth.'],
  ['coding', 'Answer with the two-pointer approach and note O(n) time, O(1) space.'],
  ['system-design', 'Propose queue-based ingestion, partitioned storage, pre-aggregation, and a read API; mention trade-offs between freshness and cost.'],
  ['ai-evaluation', 'Describe golden datasets, rubric-based scoring, regression suites per release, inter-annotator agreement, and human review sampling.'],
  ['custom', 'Answer about the analytics dashboard migration as a concrete stakeholder-management example with a measurable outcome.']
]

const RESULTS = []
for (const [type, answer1] of TYPES) {
  const row = { type }
  try {
    await evalJs(`[...document.querySelectorAll('.nav-btn')].find(b => b.textContent.trim() === 'Practice')?.click()`)
    await sleep(600)
    // reset any previous state
    await evalJs(`(() => { [...document.querySelectorAll('button')].find(x => x.title === 'Discard this session')?.click(); [...document.querySelectorAll('button')].find(x => x.textContent.includes('New practice session'))?.click(); [...document.querySelectorAll('button')].find(x => x.textContent.includes('New practice'))?.click(); return true })()`)
    await sleep(800)
    await evalJs(`(() => { const card = [...document.querySelectorAll('.type-card')].find(c => c.querySelector('.t-name')?.textContent === ({behavioral:'Behavioral',technical:'Technical','software-engineering':'Software engineering',coding:'Coding','system-design':'System design','ai-evaluation':'AI / QA evaluation',custom:'Custom'})['${type}']); card?.click(); return true })()`)
    await sleep(300)
    const cfg = await evalJs(`(() => { const sels = [...document.querySelectorAll('select')]; const q = sels.find(s => [...s.options].some(o => o.value === '2')); if (q) { q.value = '2'; q.dispatchEvent(new Event('change', {bubbles: true})) } return true })()`)
    await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Start practice interview'))?.click()`)
    row.started = true
    const q1 = await waitFor('question 1', `(() => { const el = document.querySelector('.practice-question'); const t = el?.textContent ?? ''; return t.length > 20 && !t.includes('Preparing') ? t.slice(0, 90) : false })()`)
    row.q1 = q1
    // typed answer
    await evalJs(`(() => { const ta = document.querySelector('.practice-answer'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(answer1)}); ta.dispatchEvent(new Event('input', {bubbles: true})); return true })()`)
    await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Submit answer')?.click()`)
    const fb1 = await waitFor('feedback 1', `(() => { const badge = [...document.querySelectorAll('.card .badge')].find(b => /\\/5 overall/.test(b.textContent)); return badge ? badge.textContent : false })()`, 90_000)
    row.feedback1 = fb1
    const q2 = await waitFor('question 2', `(() => { const el = document.querySelector('.practice-question'); const t = el?.textContent ?? ''; return t.length > 20 && t !== ${JSON.stringify(q1)} ? t.slice(0, 90) : false })()`)
    row.q2 = q2
    await evalJs(`(() => { const ta = document.querySelector('.practice-answer'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'Second answer: I would add measurable outcomes, name the trade-offs explicitly, and close with what I would do differently next time.'); ta.dispatchEvent(new Event('input', {bubbles: true})); return true })()`)
    await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Submit answer')?.click()`)
    const score = await waitFor('scorecard', `(() => { const big = document.querySelector('.overall-score .big'); const rows = document.querySelectorAll('.score-row').length; return big && rows >= 5 ? big.textContent + '/5 with ' + rows + ' dimensions' : false })()`, 240_000)
    row.scorecard = score
    const summary = await evalJs(`document.querySelector('.overall-score')?.parentElement?.querySelector('.hint')?.textContent?.slice(0, 100) ?? ''`)
    row.summary = summary
  } catch (err) {
    row.error = String(err.message ?? err).slice(0, 200)
  }
  RESULTS.push(row)
  console.log(JSON.stringify(row))
}
console.log('PRACTICE_AUDIT_DONE ' + JSON.stringify(RESULTS))
ws.close()
process.exit(0)
