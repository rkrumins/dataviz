/**
 * Drive the scale harness through the real browser and hold it to its budgets.
 *
 * Each fixture of `src/harness/scaleHarness.tsx` (Review & Save on 50,000 staged changes, its
 * Map, a 100,000-change list, the canvas navigator) is opened in headless Chromium; the page times
 * itself — how long until it shows, every long task while it steps, scrolls, filters and draws —
 * into `window.__scale`, which this reads over the DevTools Protocol, checks against BUDGETS, and
 * screenshots to `.harness/`. Exits 1 past a budget, so a slowdown fails where it is introduced.
 *
 *   node scripts/scale-shot.mjs [fixture[:dark] ...]
 *
 * Same shape as `revision-shot.mjs` (its own Vite on 5199, the Playwright-installed Chromium or
 * CHROMIUM_PATH); no browser-automation dependency — Node 22's WebSocket speaks the protocol.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5199
const CDP_PORT = 9333
const OUT = '.harness'

/** How long a fixture may take to show, and the longest task any step may cause (ms). */
const BUDGETS = {
  review: { openMs: 1000, longTaskMs: 200 },
  map: { openMs: 1000, longTaskMs: 300 },
  changes: { openMs: 2000, longTaskMs: 200 },
  tree: { openMs: 1000, longTaskMs: 200 },
  'review-tree': { openMs: 1000, longTaskMs: 200 },
  navigator: { openMs: 1000, longTaskMs: 200 },
}

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'review', 'review:dark', 'map', 'map:dark', 'changes', 'changes:dark', 'tree', 'tree:dark', 'review-tree', 'review-tree:dark', 'navigator', 'navigator:dark',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, 'chrome-linux', 'chrome')
      if (dir.startsWith('chromium-') && existsSync(p)) return p
    }
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p)) ?? null
}

async function startVite() {
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
    vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
    vite.stderr.on('data', (d) => {
      if (String(d).includes('is in use')) {
        clearTimeout(timer)
        reject(new Error(`Port ${PORT} is already serving an older build. Stop it first:  pkill -f "vite --port ${PORT}"`))
      }
    })
  })
  return vite
}

/** A page of a headless Chromium on a throwaway profile, and a way to talk to it. */
async function openBrowser(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'scale-shot-'))
  const chrome = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1440,940', 'about:blank',
  ], { stdio: 'ignore', detached: true })
  let target
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* not up yet */ }
    if (!target) await sleep(100)
  }
  if (!target) throw new Error('Chromium did not open a page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id
    waiting.set(mid, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false })
  const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  return { cdp, evaluate, close: () => { ws.close(); try { process.kill(-chrome.pid, 'SIGTERM') } catch { /* gone */ } } }
}

const bin = findChromium()
if (!bin) {
  console.error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const vite = await startVite()
const failures = []
const summary = {}
try {
  const browser = await openBrowser(bin)
  try {
    for (const shot of SHOTS) {
      const [fixture, ...flags] = shot.split(':')
      const query = [`fixture=${fixture}`, ...(flags.includes('dark') ? ['theme=dark'] : [])]
      await browser.cdp('Page.navigate', { url: `http://localhost:${PORT}/scale-harness.html?${query.join('&')}` })
      let report
      for (let i = 0; i < 600 && !report?.done; i++) {
        await sleep(100)
        report = await browser.evaluate('window.__scale && JSON.parse(JSON.stringify(window.__scale))').catch(() => null)
      }
      const budget = BUDGETS[fixture]
      const worst = Math.max(0, ...Object.values(report?.steps ?? {}).flat())
      summary[shot] = { openMs: report?.openMs, worstStepTaskMs: worst, steps: report?.steps, error: report?.error }
      if (!report?.done) failures.push(`${shot}: never finished`)
      else if (report.error) failures.push(`${shot}: ${report.error}`)
      else {
        if (report.openMs !== undefined && report.openMs > budget.openMs) failures.push(`${shot}: shown in ${report.openMs} ms (budget ${budget.openMs})`)
        if (worst > budget.longTaskMs) failures.push(`${shot}: a ${worst} ms task while in use (budget ${budget.longTaskMs})`)
      }
      const { data } = await browser.cdp('Page.captureScreenshot', { format: 'png' })
      const out = join(OUT, `scale-${shot.replace(/:/g, '-')}.png`)
      writeFileSync(out, Buffer.from(data, 'base64'))
      console.log(`  ${failures.some((f) => f.startsWith(`${shot}:`)) ? '✗' : '✓'} ${out}  shown ${report?.openMs ?? '–'} ms, worst task ${worst} ms`)
    }
  } finally {
    browser.close()
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { /* gone */ }
}
writeFileSync(join(OUT, 'scale-report.json'), JSON.stringify(summary, null, 2))
if (failures.length) {
  console.error(`\nOver budget:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nWithin budget.')
process.exit(0)
