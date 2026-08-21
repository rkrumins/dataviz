// Real-browser certification of the LINEAGE LENS against the dev stack (no
// deps: Node 22+'s WebSocket + Playwright's chrome-headless-shell over CDP).
// Logs in through the app, opens the view with a Lens share link on the focus,
// and records every /trace/closure request, the narration over time, cards in
// the DOM, the strips, the fitted zoom, console errors. Numbers, not beliefs.
//
//   node scripts/browser_probe_lens.mjs <viewId> <focusUrn> [oneHop|fullFlow]
//   PROFILE_AT=60 PROFILE_FOR=60 node scripts/browser_probe_lens.mjs … fullFlow
//       → also samples the V8 profiler mid-walk and prints the top self-time
//         frames (how `boundaryHops` was found, 2026-08-21).
//
// Credentials: ADMIN_EMAIL / ADMIN_PASSWORD from .env.dev (never printed).
// CHROME: set to your chrome-headless-shell if the Playwright cache path differs.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const APP = process.env.APP_BASE ?? 'http://localhost:5173'
const [viewId, focusUrn, mode = 'oneHop'] = process.argv.slice(2)
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(readFileSync(`${root}/.env.dev`, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] }))

const port = 9333
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless', '--disable-gpu', '--no-sandbox', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
await new Promise(r => setTimeout(r, 1200))
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.onopen = r)
let id = 0; const pending = new Map(); const events = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  else if (msg.method) events.push(msg)
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')

// 1. login through the app's own API (cookies land in the browser)
await send('Page.navigate', { url: `${APP}/login` }); await sleep(1500)
const loginStatus = await evalJs(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(env.ADMIN_EMAIL)},password:${JSON.stringify(env.ADMIN_PASSWORD)}})}).then(r=>r.status)`)
console.log('login', loginStatus)

// 2. open the view with a Lens share link on the focus
const share = { v: 3, entries: [focusUrn], cursor: 0, mode: 'graph', direction: 'both', depth: 1, revealed: [], opened: [], collapsed: [], frameAll: [], framePages: [], frameQueries: [], pinned: [], railWindow: null, condensedOpen: [] }
const token = Buffer.from(JSON.stringify(share), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const requests = []
const t0 = Date.now()
const url = `${APP}/views/${viewId}?lens=${token}`
await send('Page.navigate', { url })
console.log('navigated', url.slice(0, 80) + '…')

// Poll the board for up to 3 minutes, recording narration + card counts.
const samples = []
let fullFlowClicked = false
let fullFlowAt = 0, profiling = false, profileDone = false
for (let i = 0; i < 420; i++) {
  await sleep(1000)
  for (const e of events.splice(0)) {
    if (e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/trace/closure')) {
      let body = {}
      try { body = JSON.parse(e.params.request.postData ?? '{}') } catch {}
      requests.push({ t: Date.now() - t0, seedCursor: body.seedCursor ?? null, seeds: body.seedUrns?.length ?? 0, after: body.afterCursor ?? null, depth: [body.upstreamDepth, body.downstreamDepth], maxNodes: body.maxNodes ?? null })
    }
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') console.log('CONSOLE ERROR:', JSON.stringify(e.params.args?.map(a => a.value ?? a.description)).slice(0, 300))
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') console.log('LOG ERROR:', e.params.entry.text.slice(0, 300))
  }
  const s = await evalJs(`(() => {
    const n = document.querySelector('[data-testid="lens-walk-narration"]')?.textContent ?? null
    const cards = document.querySelectorAll('.react-flow__node').length
    const strips = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /continue|try again|keep walking|load everything|load more/i.test(t))
    const chip = [...document.querySelectorAll('p,span')].map(x => x.textContent).find(t => /full flow drawn|immediate lineage complete/i.test(t)) ?? null
    const oneHop = document.querySelector('button[aria-pressed="true"]')?.textContent?.trim() ?? null
    const scale = Number((/scale\(([\d.e-]+)\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '') ?? [])[1] ?? NaN)
    const grew = !!document.querySelector('button')?.ownerDocument && [...document.querySelectorAll('button')].some(b => /board grew/i.test(b.textContent))
    return { n, cards, strips, chip, oneHop, scale, grew }
  })()`)
  samples.push({ t: Date.now() - t0, ...s })
  const last = samples[samples.length - 1]
  if (process.env.PROBE_VERBOSE && (i % 5 === 0)) console.log(`  [${(last.t/1000).toFixed(0)}s] dom=${last.cards} scale=${last.scale.toFixed(3)} grew=${last.grew} n=${last.n}`)
  const settled = requests.length > 0 && !last.n && (Date.now() - t0) > 4000
  if (process.env.PROFILE_AT && fullFlowClicked && !profiling && (Date.now() - fullFlowAt) > Number(process.env.PROFILE_AT) * 1000) {
    profiling = true
    await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 }); await send('Profiler.start')
    console.log('profiler started at', Date.now() - t0, 'ms')
    setTimeout(async () => {
      const { result } = await send('Profiler.stop')
      const prof = result.profile
      const self = new Map(); const byId = new Map(prof.nodes.map(n => [n.id, n]))
      let total = 0
      for (let k = 0; k < prof.samples.length; k++) { const n = byId.get(prof.samples[k]); const dt = prof.timeDeltas[k] ?? 0; total += dt; const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + dt) }
      // Also aggregate by file to see where the time lives.
      const byFile = new Map()
      for (let k = 0; k < prof.samples.length; k++) { const n = byId.get(prof.samples[k]); const dt = prof.timeDeltas[k] ?? 0; const f = n.callFrame.url.split('/').slice(-1)[0] || n.callFrame.functionName; byFile.set(f, (byFile.get(f) ?? 0) + dt) }
      console.log(`\n== profile: ${(total / 1e6).toFixed(1)} s sampled`)
      console.log('-- top self-time frames:')
      for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`   ${(v / 1e6).toFixed(2)} s  ${k}`)
      console.log('-- by file:')
      for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${(v / 1e6).toFixed(2)} s  ${k}`)
      profileDone = true
    }, Number(process.env.PROFILE_FOR ?? 60) * 1000)
  }
  if (profileDone) break
  if (mode === 'fullFlow' && settled && !fullFlowClicked) {
    fullFlowClicked = true
    fullFlowAt = Date.now()
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => /full flow/i.test(b.textContent) && b.getAttribute('aria-pressed') === 'false'); if (b) { b.click(); return 'clicked' } return 'no toggle' })()`)
    console.log('switched to Full flow at', Date.now() - t0, 'ms')
    continue
  }
  if (settled && (mode !== 'fullFlow' || fullFlowClicked) && i > 6) {
    const lastN = samples.slice(-4).map(x => x.n)
    if (lastN.every(x => !x)) break
  }
}
console.log('\n== requests:', requests.length)
for (const r of requests.slice(0, 25)) console.log('  ', JSON.stringify(r))
if (requests.length > 25) console.log('   …', requests.length - 25, 'more')
console.log('\n== narration timeline (changes only):')
let prev = null
for (const s of samples) { const k = `${s.n}|${s.cards}|${s.strips.join(',')}|${s.chip}`; if (k !== prev) { console.log(`  t=${(s.t / 1000).toFixed(1)}s dom=${s.cards} scale=${Number.isFinite(s.scale) ? s.scale.toFixed(3) : "?"} grew=${s.grew} narration=${JSON.stringify(s.n)} chip=${JSON.stringify(s.chip)} strips=${JSON.stringify(s.strips)} mode=${s.oneHop}`); prev = k } }
const final = samples[samples.length - 1]
console.log('\n== FINAL: cards in DOM =', final.cards, '| requests =', requests.length, '| strips =', JSON.stringify(final.strips), '| scale =', final.scale, '| grew pill =', final.grew, '| wall =', (final.t / 1000).toFixed(1), 's')
// Fit the whole board and read the zoom + how many cards the DOM now holds.
// Density (Part H): which rung is pressed, and how the board divides into frames, rows and loose cards.
const density = await evalJs(`(() => { const g = document.querySelector('[role="group"][aria-label="How much of the picture to fold"]'); if (!g) return null; const on = [...g.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true'); const nodes = [...document.querySelectorAll('.react-flow__node')]; const frames = nodes.filter(n => n.querySelector('[role="list"], [aria-label^="Rows"], .nx-frame-rows')).length; const rows = nodes.filter(n => n.closest('.react-flow__node')?.parentElement?.closest('.react-flow__node')).length; return { rung: on?.textContent?.trim() ?? null, nodes: nodes.length, frames, rows } })()`)
console.log('== density:', JSON.stringify(density))
const fit = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => /board grew/i.test(b.textContent)) ?? document.querySelector('button[aria-label="Fit the lineage in view"]'); if (!b) return 'no fit button'; b.click(); return 'clicked ' + b.textContent.trim() })()`)
await sleep(1500)
const afterFit = await evalJs(`(() => ({ scale: Number((/scale\\(([\\d.e-]+)\\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '') ?? [])[1] ?? NaN), dom: document.querySelectorAll('.react-flow__node').length, grew: [...document.querySelectorAll('button')].some(b => /board grew/i.test(b.textContent)) }))()`)
console.log('== after Fit:', fit, JSON.stringify(afterFit))
const zoomed = await evalJs(`(async () => { const b = document.querySelector('button[aria-label="Zoom in"]'); for (let i = 0; i < 6; i++) { b?.click(); await new Promise(r => setTimeout(r, 250)) } return { scale: Number((/scale\\(([\\d.e-]+)\\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '') ?? [])[1] ?? NaN), dom: document.querySelectorAll('.react-flow__node').length } })()`)
console.log('== after zooming in 6×:', JSON.stringify(zoomed))
if (process.env.DENSITY_SWEEP) {
  for (const rung of ['Every card', 'Overview', 'Grouped']) {
    const r = await evalJs(`(async () => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(rung)}); if (!b) return 'no button'; b.click(); await new Promise(r => setTimeout(r, 2500)); const fitB = document.querySelector('button[aria-label="Fit the lineage in view"]'); fitB?.click(); await new Promise(r => setTimeout(r, 800)); return { rung: ${JSON.stringify(rung)}, dom: document.querySelectorAll('.react-flow__node').length, scale: Number((/scale\\(([\\d.e-]+)\\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '') ?? [])[1] ?? NaN), chip: ([...document.querySelectorAll('p,span')].map(x => x.textContent).find(t => /connections/.test(t)) ?? '').slice(0, 60) } })()`)
    console.log('== rung', JSON.stringify(r))
  }
}
ws.close(); chrome.kill(); process.exit(0)
