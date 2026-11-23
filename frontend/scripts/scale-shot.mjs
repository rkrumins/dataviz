/**
 * Drive the scale harness through the real browser and hold it to its budgets.
 *
 * Each fixture of `src/harness/scaleHarness.tsx` (Review & Save on 50,000 staged changes, its
 * Map, a 100,000-change list, the canvas navigator; and bulk editing: the drawer on 10,000 entities
 * and on 1,000 relationships, a merge of 1,000 values, 60 jobs ticking) is opened in headless
 * Chromium; the page times itself — how long until it shows, every long task while it steps,
 * scrolls, filters and draws — into `window.__scale`, which this reads over the DevTools Protocol,
 * checks against BUDGETS, and screenshots to `.harness/`. Exits 1 past a budget, so a slowdown
 * fails where it is introduced.
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

/** How long a fixture may take to show, and the longest task any step may cause (ms). `steps`: a
 *  step held to a budget of its own, for a task it does in one go on purpose. */
const BUDGETS = {
  review: { openMs: 1000, longTaskMs: 200 },
  map: { openMs: 1000, longTaskMs: 300 },
  changes: { openMs: 2000, longTaskMs: 200 },
  tree: { openMs: 1000, longTaskMs: 200 },
  'review-tree': { openMs: 1000, longTaskMs: 200 },
  navigator: { openMs: 1000, longTaskMs: 200 },
  // Staging writes every entity's edit (9,166 here) as one Undo step, then reads the comparison of
  // 10,000 × 50 values again: one task by design — some 450–700 ms on a busy 4-core machine.
  'multi-entity': { openMs: 1500, longTaskMs: 200, steps: { stage: 800 } },
  'cleanup-merge': { openMs: 1000, longTaskMs: 200 },
  'multi-relationship': { openMs: 1000, longTaskMs: 200 },
  'jobs-panel': { openMs: 1000, longTaskMs: 200 },
}

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'review', 'review:dark', 'map', 'map:dark', 'changes', 'changes:dark', 'tree', 'tree:dark', 'review-tree', 'review-tree:dark', 'navigator', 'navigator:dark',
  'multi-entity', 'multi-entity:dark', 'cleanup-merge', 'cleanup-merge:dark', 'multi-relationship', 'multi-relationship:dark', 'jobs-panel', 'jobs-panel:dark',
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

/** Vite's output without its colour codes: with CI set it prints "Local" in bold, between them. */
const plain = (d) => String(d).replace(/\x1b\[[0-9;]*m/g, '')

async function startVite() {
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
    vite.stdout.on('data', (d) => { if (plain(d).includes('Local:')) { clearTimeout(timer); resolve() } })
    vite.stderr.on('data', (d) => {
      if (plain(d).includes('is in use')) {
        clearTimeout(timer)
        reject(new Error(`Port ${PORT} is already serving an older build. Stop it first:  pkill -f "vite --port ${PORT}"`))
      }
    })
  })
  return vite
}

/** A page of a headless Chromium on a throwaway profile, and a way to talk to it. Chromium says on
 *  stderr where its DevTools listen ("DevTools listening on ws://HOST:PORT/…"), which is where the
 *  page is looked for; one that has opened no page is asked for one; one that never answers fails
 *  with what it said. */
async function openBrowser(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'scale-shot-'))
  const chrome = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1440,940', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let said = ''
  let devtools = null
  let exited = null
  chrome.stderr.on('data', (d) => {
    said = (said + d).slice(-4000)
    devtools ??= /DevTools listening on ws:\/\/([^/\s]+)\//.exec(said)?.[1] ?? null
  })
  chrome.on('exit', (code, signal) => { exited = signal ?? code })
  let target
  for (let i = 0; i < 600 && !target && exited === null; i++) {
    const base = `http://${devtools ?? `127.0.0.1:${CDP_PORT}`}`
    try {
      target = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.type === 'page')
        ?? await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json()
    } catch { /* not answering yet */ }
    if (!target) await sleep(100)
  }
  if (!target) {
    try { process.kill(-chrome.pid, 'SIGTERM') } catch { /* gone */ }
    throw new Error(`Chromium did not open a page ${exited === null ? 'in 60s' : `(it exited: ${exited})`}, `
      + `${devtools ? `its DevTools on ${devtools}` : 'never saying where its DevTools listen'}. It said:\n${said.trim() || '(nothing)'}`)
  }
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
      const own = budget.steps ?? {}
      const worst = Math.max(0, ...Object.entries(report?.steps ?? {}).filter(([s]) => !(s in own)).flatMap(([, tasks]) => tasks))
      const ownWorst = Object.fromEntries(Object.keys(own).map((s) => [s, Math.max(0, ...(report?.steps?.[s] ?? []))]))
      summary[shot] = { openMs: report?.openMs, worstStepTaskMs: worst, steps: report?.steps, checks: report?.checks, error: report?.error }
      if (!report?.done) failures.push(`${shot}: never finished`)
      else if (report.error) failures.push(`${shot}: ${report.error}`)
      else {
        if (report.openMs !== undefined && report.openMs > budget.openMs) failures.push(`${shot}: shown in ${report.openMs} ms (budget ${budget.openMs})`)
        if (worst > budget.longTaskMs) failures.push(`${shot}: a ${worst} ms task while in use (budget ${budget.longTaskMs})`)
        for (const [s, ms] of Object.entries(ownWorst)) if (ms > own[s]) failures.push(`${shot}: a ${ms} ms task on ${s} (budget ${own[s]})`)
      }
      const { data } = await browser.cdp('Page.captureScreenshot', { format: 'png' })
      const out = join(OUT, `scale-${shot.replace(/:/g, '-')}.png`)
      writeFileSync(out, Buffer.from(data, 'base64'))
      const checks = [...Object.entries(ownWorst).map(([s, ms]) => `, ${s} ${ms} ms`),
        ...Object.entries(report?.checks ?? {}).map(([k, v]) => `, ${k} ${v}`)].join('')
      console.log(`  ${failures.some((f) => f.startsWith(`${shot}:`)) ? '✗' : '✓'} ${out}  shown ${report?.openMs ?? '–'} ms, worst task ${worst} ms${checks}`)
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
