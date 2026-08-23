// Real-browser certification of the CANVAS TRACE against the dev stack (same
// recipe as browser_probe_lens.mjs). Opens the view, selects the focus in the
// canvas store (Vite serves the app's own module instance, so no UI plumbing is
// needed to reach a node buried under a closed root), presses the header's
// "Trace Lineage", and records the capsule's phase + text, the cards and count
// pills on the canvas, the dock strip, every /trace/closure request, errors.
//
//   node scripts/browser_probe_trace.mjs <viewId> <focusUrn>
//
// Credentials: ADMIN_EMAIL / ADMIN_PASSWORD from .env.dev (never printed).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const APP = process.env.APP_BASE ?? 'http://localhost:5173'
const [viewId, focusUrn] = process.argv.slice(2)
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(readFileSync(`${root}/.env.dev`, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] }))

const port = 9334
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless', '--disable-gpu', '--no-sandbox', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
await new Promise(r => setTimeout(r, 1200))
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.onopen = r)
let id = 0; const pending = new Map(); const events = []
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } else if (msg.method) events.push(msg) }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')

await send('Page.navigate', { url: `${APP}/login` }); await sleep(1500)
console.log('login', await evalJs(`fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(env.ADMIN_EMAIL)},password:${JSON.stringify(env.ADMIN_PASSWORD)}})}).then(r=>r.status)`))

const share = { v: 3, entries: [focusUrn], cursor: 0, mode: 'graph', direction: 'both', depth: 1, revealed: [], opened: [], collapsed: [], frameAll: [], framePages: [], frameQueries: [], pinned: [], railWindow: null, condensedOpen: [] }
const token = Buffer.from(JSON.stringify(share), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const requests = []
const t0 = Date.now()
await send('Page.navigate', { url: `${APP}/views/${viewId}` })

const drain = () => { for (const e of events.splice(0)) {
  if (e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/trace/closure')) { let body = {}; try { body = JSON.parse(e.params.request.postData ?? '{}') } catch {} ; requests.push({ t: Date.now() - t0, urn: (body.urn ?? '').slice(-12), seedCursor: !!body.seedCursor, seeds: body.seedUrns?.length ?? 0, after: body.afterCursor ?? null, depth: [body.upstreamDepth, body.downstreamDepth], maxNodes: body.maxNodes ?? null }) }
  if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') console.log('CONSOLE ERROR:', JSON.stringify(e.params.args?.map(a => a.value ?? a.description)).slice(0, 300))
  if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') console.log('LOG ERROR:', e.params.entry.text.slice(0, 200), e.params.entry.url?.slice(-60))
} }

// 1. Let the canvas land.
await sleep(6000); drain()
console.log('canvas landed at', Date.now() - t0, 'ms, cards =', await evalJs(`document.querySelectorAll('[id^="layer-node-"]').length`))

// 2. Select the focus in the canvas store (Vite serves the app's own module
// instance), then press the header's "Trace Lineage" (→ startCanvasTrace).
const clicked = await evalJs(`(async () => {
  const m = await import('/src/store/canvas.ts')
  const st = m.useCanvasStore.getState()
  st.selectNode(${JSON.stringify(focusUrn)})
  await new Promise(r => setTimeout(r, 500))
  const t = [...document.querySelectorAll('button')].find(b => /Trace Lineage/.test(b.textContent))
  if (!t) return 'no Trace Lineage button'
  if (t.disabled) return 'Trace Lineage disabled (selected=' + JSON.stringify(m.useCanvasStore.getState().selectedNodeIds) + ')'
  t.click(); return 'traced'
})()`)
console.log('trace:', clicked, 'at', Date.now() - t0, 'ms')
const tTrace = Date.now()

// 3. Poll the canvas.
const samples = []
let lastKey = null
for (let i = 0; i < 400; i++) {
  await sleep(1000); drain()
  const s = await evalJs(`(() => {
    const cap = document.querySelector('[data-trace-phase]')
    const cards = document.querySelectorAll('[id^="layer-node-"]').length
    const pills = [...document.querySelectorAll('[id^="layer-node-"]')].map(n => n.textContent).filter(t => /on this lineage/.test(t)).length
    const strips = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(continue|try again|reduce depth|keep walking)$/i.test(t))
    const tracing = !!document.querySelector('[data-trace-active="true"]')
    return { phase: cap?.dataset.tracePhase ?? null, text: cap?.textContent?.slice(0, 140) ?? null, cards, pills, strips, tracing }
  })()`)
  samples.push({ t: Date.now() - tTrace, ...s })
  const key = `${s.phase}|${s.cards}|${s.pills}|${s.strips.join(',')}`
  if (key !== lastKey) { console.log(`  t=${((Date.now() - tTrace) / 1000).toFixed(1)}s phase=${s.phase} cards=${s.cards} pills=${s.pills} strips=${JSON.stringify(s.strips)} tracing=${s.tracing} text=${JSON.stringify(s.text)}`); lastKey = key }
  if (i > 5 && s.phase === null && samples.slice(-3).every(x => x.phase === null)) break
  if (s.strips.includes('Continue')) break
}
console.log('\n== requests:', requests.length); for (const r of requests.slice(0, 12)) console.log('  ', JSON.stringify(r)); if (requests.length > 12) console.log('   …', requests.length - 12, 'more')
const final = samples[samples.length - 1]
console.log('== FINAL: cards =', final.cards, '| count pills =', final.pills, '| strips =', JSON.stringify(final.strips), '| tracing =', final.tracing, '| wall since trace =', (final.t / 1000).toFixed(1), 's')
ws.close(); chrome.kill(); process.exit(0)
