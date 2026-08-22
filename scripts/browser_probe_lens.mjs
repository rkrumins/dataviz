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
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless', '--disable-gpu', '--no-sandbox', `--window-size=${process.env.WINDOW ?? '1600,1000'}`, 'about:blank'], { stdio: 'ignore' })
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

// 1b. a density preference for the run (DENSITY=overview|grouped|all) — the
// store is persisted under `nexus-preferences`; seed it before the app reads it.
if (process.env.DENSITY) {
  await evalJs(`(() => { const raw = localStorage.getItem('nexus-preferences'); const cur = raw ? JSON.parse(raw) : { state: {}, version: 5 }; cur.state = { ...(cur.state ?? {}), lensDensity: ${JSON.stringify(process.env.DENSITY)} }; cur.version = 5; localStorage.setItem('nexus-preferences', JSON.stringify(cur)); return 'seeded' })()`)
  console.log('density preference seeded:', process.env.DENSITY)
}

// 2. open the view with a Lens share link on the focus
const share = { v: 3, entries: [...(process.env.TRAIL ? process.env.TRAIL.split(',') : []), focusUrn], cursor: (process.env.TRAIL ? process.env.TRAIL.split(',').length : 0), mode: 'graph', direction: 'both', depth: Number(process.env.DEPTH ?? 1), revealed: [], opened: [focusUrn], collapsed: [], frameAll: [], framePages: [], frameQueries: [], pinned: [], railWindow: null, condensedOpen: [] }
const token = Buffer.from(JSON.stringify(share), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const requests = []
const t0 = Date.now()
const url = `${APP}/views/${viewId}?lens=${token}`
await send('Page.navigate', { url })
console.log('navigated', url.slice(0, 80) + '…')

// Poll the board for up to 3 minutes, recording narration + card counts.
const samples = []
const shotKeys = new Set()
let fullFlowClicked = false
let fullFlowAt = 0, profiling = false, profileDone = false
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 1000)
for (let i = 0; i < Math.round(420 * 1000 / SAMPLE_MS); i++) {
  await sleep(SAMPLE_MS)
  for (const e of events.splice(0)) {
    if (e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/trace/closure')) {
      let body = {}
      try { body = JSON.parse(e.params.request.postData ?? '{}') } catch {}
      requests.push({ id: e.params.requestId, t: Date.now() - t0, grain: body.grain ?? 'fine', seedCursor: body.seedCursor ?? null, seeds: body.seedUrns?.length ?? 0, after: body.afterCursor ?? null, depth: [body.upstreamDepth, body.downstreamDepth], maxNodes: body.maxNodes ?? null, done: null })
    }
    if (e.method === 'Network.loadingFinished') {
      const r = requests.find(r => r.id === e.params.requestId)
      if (r) r.done = Date.now() - t0
    }
    if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) console.log(`CONSOLE ${e.params.type.toUpperCase()}:`, JSON.stringify(e.params.args?.map(a => a.value ?? a.description)).slice(0, 300))
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') console.log('LOG ERROR:', e.params.entry.text.slice(0, 300))
  }
  const s = await evalJs(`(() => {
    const n = document.querySelector('[data-testid="lens-walk-narration"]')?.textContent ?? null
    const cards = document.querySelectorAll('.react-flow__node').length
    const strips = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /continue|try again|keep walking|load everything|load more/i.test(t))
    const chip = [...document.querySelectorAll('p,span')].map(x => x.textContent).find(t => /full flow drawn|immediate lineage complete/i.test(t)) ?? null
    const oneHop = document.querySelector('button[aria-pressed="true"]')?.textContent?.trim() ?? null
    const scale = (() => { const t = document.querySelector('.react-flow__viewport')?.style.transform ?? ''; const i = t.indexOf('scale('); return i < 0 ? NaN : Number(t.slice(i + 6, t.indexOf(')', i))) })()
    const grew = !!document.querySelector('button')?.ownerDocument && [...document.querySelectorAll('button')].some(b => /board grew/i.test(b.textContent))
    const capsule = document.querySelector('[role="status"][data-trace-phase]')
    const capsuleText = capsule ? (capsule.getAttribute('data-trace-phase') + ': ' + capsule.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120)) : null
    const capsulePhase = capsule?.getAttribute('data-trace-phase') ?? null
    const guidance = !!document.querySelector('[data-testid="walk-guidance"]')
    const skeleton = !!document.querySelector('[data-testid="lens-skeleton"]')
    return { n, cards, strips, chip, oneHop, scale, grew, capsuleText, capsulePhase, guidance, skeleton }
  })()`)
  samples.push({ t: Date.now() - t0, ...s })
  // A picture of every loading state the reader can see: each capsule
  // phase the first time it shows, and the first line of guidance.
  const shotKey = s.capsulePhase ? (s.guidance ? `${s.capsulePhase}-guidance` : s.capsulePhase) : null
  if (process.env.SCREENSHOT_DIR && shotKey && !shotKeys.has(shotKey)) {
    shotKeys.add(shotKey)
    const { writeFileSync } = await import('node:fs')
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-loading-${shotKey}.png`, Buffer.from(shot.result.data, 'base64'))
    console.log('== screenshot (loading)', `lens-loading-${shotKey}.png`, '@', Date.now() - t0, 'ms', 'skeleton=', s.skeleton)
  }
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
for (const r of requests.slice(0, 25)) console.log('  ', JSON.stringify({ ...r, id: undefined }))
if (requests.length > 25) console.log('   …', requests.length - 25, 'more')
console.log('\n== narration timeline (changes only):')
let prev = null
for (const s of samples) { const k = `${s.n}|${s.cards}|${s.strips.join(',')}|${s.chip}|${s.capsuleText}`; if (k !== prev) { console.log(`  t=${(s.t / 1000).toFixed(1)}s dom=${s.cards} scale=${Number.isFinite(s.scale) ? s.scale.toFixed(3) : "?"} grew=${s.grew} narration=${JSON.stringify(s.n)} chip=${JSON.stringify(s.chip)} strips=${JSON.stringify(s.strips)} mode=${s.oneHop} capsule=${JSON.stringify(s.capsuleText)}`); prev = k } }
const firstReq = requests[0]?.t ?? null
const firstCards = samples.find(s => s.cards > 0)
console.log(`\n== first paint: first request at ${firstReq} ms, first cards in the DOM at ${firstCards?.t ?? '?'} ms (${firstCards && firstReq != null ? firstCards.t - firstReq : '?'} ms after the request, ${firstCards?.cards ?? 0} cards)`)
const final = samples[samples.length - 1]
if (process.env.SCREENSHOT_DIR) {
  const { writeFileSync } = await import('node:fs')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-settled.png`, Buffer.from(shot.result.data, 'base64'))
  const H = Number((process.env.WINDOW ?? '1600,1000').split(',')[1])
  const W = Number((process.env.WINDOW ?? '1600,1000').split(',')[0])
  const foot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: H - 90, width: W, height: 90, scale: 1 } })
  writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-footer.png`, Buffer.from(foot.result.data, 'base64'))
  console.log('== footer:', await evalJs(`document.querySelector('[aria-label="On the board"]')?.textContent ?? null`))
}
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
    const scaleExpr = `Number((/scale\\(([\\d.e-]+)\\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '') ?? [])[1] ?? NaN)`
    const switched = await evalJs(`(async () => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(rung)}); if (!b) return 'no button'; b.click(); await new Promise(r => setTimeout(r, 2500)); return { rung: ${JSON.stringify(rung)}, dom: document.querySelectorAll('.react-flow__node').length, scaleOnSwitch: ${scaleExpr} } })()`)
    if (process.env.SCREENSHOT_DIR) {
      const { writeFileSync } = await import('node:fs')
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-${rung.replace(/\s+/g, '_').toLowerCase()}-onswitch.png`, Buffer.from(shot.result.data, 'base64'))
    }
    const fitted = await evalJs(`(async () => { document.querySelector('button[aria-label="Fit the lineage in view"]')?.click(); await new Promise(r => setTimeout(r, 800)); return { scaleAfterFit: ${scaleExpr}, chip: ([...document.querySelectorAll('p,span')].map(x => x.textContent).find(t => /connections/.test(t)) ?? '').slice(0, 60) } })()`)
    console.log('== rung', JSON.stringify({ ...switched, ...fitted }))
    if (process.env.SCREENSHOT_DIR) {
      const { writeFileSync } = await import('node:fs')
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const file = `${process.env.SCREENSHOT_DIR}/lens-${rung.replace(/\s+/g, '_').toLowerCase()}.png`
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      console.log('== screenshot', file)
    }
  }
}
if (process.env.WIRES_SWEEP) {
  // How many wires the board draws per Wires rung, and what a hovered
  // bundle fans out into.
  for (const rung of ['Every wire', 'Bundled', 'Auto']) {
    const r = await evalJs(`(async () => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(rung)}); if (!b) return 'no button'; b.click(); await new Promise(r => setTimeout(r, 1200)); const edges = [...document.querySelectorAll('.react-flow__edge')]; return { rung: ${JSON.stringify(rung)}, wires: edges.length, bundles: edges.filter(e => e.getAttribute('data-id')?.startsWith('b:')).length } })()`)
    console.log('== wires', JSON.stringify(r))
    if (process.env.SCREENSHOT_DIR) {
      const { writeFileSync } = await import('node:fs')
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-wires-${rung.replace(/\s+/g, '_').toLowerCase()}.png`, Buffer.from(shot.result.data, 'base64'))
    }
  }
  // Hover the first bundle: its members should come back.
  const box = await evalJs(`(() => { const e = [...document.querySelectorAll('.react-flow__edge')].find(e => e.getAttribute('data-id')?.startsWith('b:')); if (!e) return null; const p = e.querySelector('path.react-flow__edge-interaction') ?? e.querySelector('path'); const len = p.getTotalLength(); const pt = p.getPointAtLength(len / 2); const m = p.getScreenCTM(); return { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f } })()`)
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await sleep(500)
    const hovered = await evalJs(`(() => { const edges = [...document.querySelectorAll('.react-flow__edge')]; return { wires: edges.length, bundles: edges.filter(e => e.getAttribute('data-id')?.startsWith('b:')).length } })()`)
    console.log('== hovering a bundle:', JSON.stringify(hovered))
    if (process.env.SCREENSHOT_DIR) {
      const { writeFileSync } = await import('node:fs')
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-wires-hover.png`, Buffer.from(shot.result.data, 'base64'))
    }
  } else console.log('== hovering a bundle: none on the board')
}
if (process.env.TRAIL) {
  const trail = await evalJs(`document.querySelector('nav[aria-label="Path"]')?.textContent ?? null`)
  console.log('== path trail:', JSON.stringify(trail))
}
if (process.env.PAN_AWAY && process.env.SCREENSHOT_DIR) {
  // Drag the board two screens to the right so the focus leaves the pane,
  // read what the board offers, click it, and read again.
  const pane = await evalJs(`(() => { const r = document.querySelector('.react-flow__pane')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
  if (pane) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x - 300, y: pane.y + 100 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pane.x - 300, y: pane.y + 100, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 20; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x - 300 + i * 120, y: pane.y + 100, button: 'left' })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pane.x - 300 + 2400, y: pane.y + 100, button: 'left', clickCount: 1 })
    await sleep(600)
    const offered = await evalJs(`(() => ({ pill: !!document.querySelector('[data-testid="lens-focus-offscreen"]'), header: !!([...document.querySelectorAll('button')].find(b => /center on focus/i.test(b.textContent))), transform: document.querySelector('.react-flow__viewport')?.style.transform }))()`)
    console.log('== after pan-away:', JSON.stringify(offered))
    const { writeFileSync } = await import('node:fs')
    let shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-panned-away.png`, Buffer.from(shot.result.data, 'base64'))
    const back = await evalJs(`(async () => { document.querySelector('[data-testid="lens-focus-offscreen"]')?.click(); await new Promise(r => setTimeout(r, 700)); return { pill: !!document.querySelector('[data-testid="lens-focus-offscreen"]'), transform: document.querySelector('.react-flow__viewport')?.style.transform } })()`)
    console.log('== after Center on the focus:', JSON.stringify(back))
    shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-recentered.png`, Buffer.from(shot.result.data, 'base64'))
  }
}
if (process.env.HOVER && process.env.SCREENSHOT_DIR) {
  // Rest the pointer on a header control and keep a picture of its popover.
  // A header control by its text, or a view-control chip by its category ("Density").
  const box = await evalJs(`(() => { const want = ${JSON.stringify(process.env.HOVER)}; const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === want || (b.getAttribute('aria-label') ?? '').startsWith(want + ': ')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, chip: (b.getAttribute('aria-label') ?? '').startsWith(want + ': ') } })()`)
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await sleep(600)
    const { writeFileSync } = await import('node:fs')
    const W = Number((process.env.WINDOW ?? '1600,1000').split(',')[0])
    let shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: 260, scale: 1 } })
    writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-hover.png`, Buffer.from(shot.result.data, 'base64'))
    console.log('== screenshot (hover)', `${process.env.SCREENSHOT_DIR}/lens-hover.png`)
    if (box.chip) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await sleep(500)
      const menu = await evalJs(`(() => { const m = document.querySelector('[role="menu"]'); return m ? [...m.querySelectorAll('[role="menuitemradio"]')].map(i => i.textContent.trim().slice(0, 40) + (i.getAttribute('aria-checked') === 'true' ? ' ✓' : '')) : null })()`)
      console.log('== menu:', JSON.stringify(menu))
      shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: 420, scale: 1 } })
      writeFileSync(`${process.env.SCREENSHOT_DIR}/lens-menu.png`, Buffer.from(shot.result.data, 'base64'))
      console.log('== screenshot (menu)', `${process.env.SCREENSHOT_DIR}/lens-menu.png`)
    }
  } else console.log('== hover: no such control', process.env.HOVER)
}
ws.close(); chrome.kill(); process.exit(0)
