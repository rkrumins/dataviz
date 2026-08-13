/**
 * Interactive acceptance drive of the Lineage Lens, in a real Chromium.
 *
 * Drives the harness fixtures over the Chrome DevTools Protocol (no
 * automation dependency — Node's built-in WebSocket is the client) and
 * walks the acceptance script gesture by gesture:
 *
 *   app fixture     focus an Application → real mixed-grain partners,
 *                   ⊕ a dataset one hop further, open its contents,
 *                   re-center on a column, walk Back;
 *   coarse fixture  focus a platform → rolled-up peers both sides,
 *                   drill the ×N wire to concrete constituents.
 *
 * Every step asserts DOM state and saves a PNG to .harness/e2e-*.png.
 * Exit code is the verdict.
 *
 *   node scripts/harness-e2e.mjs
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const CDP_PORT = 9224
const OUT = '.harness'

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    const p = join(root, dir, 'chrome-linux', 'chrome')
    if (existsSync(p)) return p
  }
  return null
}

const chromium = findChromium()
if (!chromium) {
  console.error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

// ── CDP client on Node's built-in WebSocket ───────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** Evaluate an expression, await its promise, return the JSON value. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`page threw: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`)
    }
    return res.result.value
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  📸 ${OUT}/${name}.png`)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Poll a page-side predicate until true or timeout. */
async function waitFor(cdp, predicate, what, timeoutMs = 10_000) {
  const start = Date.now()
  for (;;) {
    if (await cdp.eval(`Boolean(${predicate})`)) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(120)
  }
}

/** Click an element via its own .click() (all lens gestures are buttons/divs with handlers). */
async function click(cdp, selector, what) {
  const ok = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`could not click ${what} (${selector})`)
}

async function dblclick(cdp, selector, what) {
  const ok = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error(`could not double-click ${what} (${selector})`)
}

const card = urn => `[data-lens-card=${JSON.stringify(urn)}]`
let failures = 0
async function step(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures++
    console.error(`  ✗ ${name}: ${err.message}`)
  }
}

async function drive(cdp, fixture) {
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/lens-harness.html?fixture=${fixture}` })
  await sleep(400)

  if (fixture === 'app') {
    console.log('▸ app — focus an Application, walk and open')
    await step('first paint: focal + real mixed-grain partners', async () => {
      await waitFor(cdp, `document.querySelector('${card('app:portal')}')`, 'focal card')
      await waitFor(cdp, `document.querySelector('${card('ds:dim_customer')}')`, 'dataset partner')
      await waitFor(cdp, `document.querySelector('${card('col:rpt.score')}')`, 'column partner')
      await waitFor(cdp, `document.querySelectorAll('.react-flow__edge').length >= 5`, '5 wires')
    })
    await cdp.shot('e2e-app-1-first-paint')

    await step('⊕ downstream on the dataset fetches hop 2', async () => {
      await click(cdp, `${card('ds:dim_customer')} [aria-label="Expand downstream lineage of ds:dim_customer"]`, 'downstream pill')
      await waitFor(cdp, `document.querySelector('${card('ds:rpt_360')}')`, 'hop-2 partner')
    })
    await cdp.shot('e2e-app-2-hop2')

    await step('chevron opens the dataset contents in place', async () => {
      await click(cdp, `${card('ds:dim_customer')} [aria-label="Open contents of ds:dim_customer"]`, 'chevron')
      await waitFor(cdp, `document.querySelectorAll('[data-lens-card]').length >= 7`, 'children carded')
    })
    await cdp.shot('e2e-app-3-contents')

    await step('double-click re-centers; trail gains the hop; Back returns', async () => {
      await dblclick(cdp, card('col:dim.email'), 'column card')
      await waitFor(cdp, `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === 'email')`, 'trail chip')
      await waitFor(cdp, `document.querySelector('${card('col:dim.email')}')`, 're-centered focal')
      await click(cdp, `[aria-label="Back"]`, 'Back')
      await waitFor(cdp, `document.querySelector('${card('app:portal')}')`, 'original focal back')
    })
    await cdp.shot('e2e-app-4-back')
  }

  if (fixture === 'coarse') {
    console.log('▸ coarse — rolled-up peers, drill to constituents')
    await step('first paint: rollup partners on both sides', async () => {
      await waitFor(cdp, `document.querySelector('${card('plat:snowflake')}')`, 'focal')
      await waitFor(cdp, `document.querySelector('${card('plat:kafka')}')`, 'upstream rollup')
      await waitFor(cdp, `document.querySelector('${card('plat:tableau')}')`, 'downstream rollup')
    })
    await cdp.shot('e2e-coarse-1-first-paint')

    await step('drilling the ×N wire refines the opened side only', async () => {
      await click(cdp, `[title*="rolled-up connection standing for 14"]`, '×14 drill chip')
      // The anchor (kafka, farther from the focal) opens into a frame
      // holding its constituent; the focal side stays whole — its
      // constituent is recorded but NOT carded, the wire re-anchors on
      // the focal card itself.
      await waitFor(cdp, `document.querySelector('${card('ds:raw_events')}')`, 'anchor-side constituent')
      await waitFor(cdp, `document.querySelector('[data-lens-frame="plat:kafka"]')`, 'kafka frame')
      if (await cdp.eval(`Boolean(document.querySelector('${card('ds:stg_events')}'))`)) {
        throw new Error('focal-side constituent was carded — the whole side must stay whole')
      }
      await waitFor(cdp, `document.querySelectorAll('.react-flow__edge').length >= 2`, 'wires present')
    })
    await cdp.shot('e2e-coarse-2-drilled')
  }

  if (fixture === 'columns') {
    console.log('▸ columns — container fallback: dataset lineage lives on its columns')
    await step('an empty-at-grain focal paints its children-grain truth', async () => {
      await waitFor(cdp, `document.querySelector('${card('ds:t2')}')`, 'focal dataset')
      // The fallback: focal columns under its frame, source columns
      // grouped in their dataset frame upstream, consumers downstream.
      await waitFor(cdp, `document.querySelector('${card('col:t2.total_amount')}')`, 'focal column')
      await waitFor(cdp, `document.querySelector('${card('col:t1.total_amount')}')`, 'source column')
      await waitFor(cdp, `document.querySelector('${card('col:fact.gross_profit')}')`, 'consumer column')
      await waitFor(cdp, `document.querySelector('[data-lens-frame="ds:t1"]')`, 'source dataset frame')
      await waitFor(cdp, `document.querySelectorAll('.react-flow__edge').length >= 6`, '6 wires')
      // No dishonest whispers, no noise 0/0 tally on the container.
      if (await cdp.eval(`document.body.textContent.includes('No upstream lineage')`)) {
        throw new Error('empty-side whisper shown despite children-grain lineage')
      }
      if (await cdp.eval(`document.querySelector('${card('ds:t2')}').textContent.includes('0 in')`)) {
        throw new Error('container shows a 0/0 degree tally')
      }
    })
    await cdp.shot('e2e-columns-1-fallback')
  }

  if (fixture === 'domains') {
    console.log('▸ domains — macro→micro connected expand, N deep, auto-walk')
    await step('first paint: domain focal with two rollup partners', async () => {
      await waitFor(cdp, `document.querySelector('${card('dom:a')}')`, 'focal domain')
      await waitFor(cdp, `document.querySelector('${card('dom:b')}')`, 'Domain B rollup')
      await waitFor(cdp, `document.querySelector('${card('dom:c')}')`, 'Domain C rollup')
      await waitFor(cdp, `document.querySelectorAll('.react-flow__edge').length >= 2`, '2 wires')
    })
    await cdp.shot('e2e-domains-1-first-paint')

    await step('chevron on B opens CONNECTED only — the apps A reaches', async () => {
      await click(cdp, `${card('dom:b')} [aria-label="Open contents of dom:b"]`, 'B chevron')
      await waitFor(cdp, `document.querySelector('${card('app:b1')}')`, 'connected app 1')
      await waitFor(cdp, `document.querySelector('${card('app:b2')}')`, 'connected app 2')
      await waitFor(cdp, `document.querySelector('[data-lens-frame="dom:b"]')`, 'B frame')
      await waitFor(cdp, `document.querySelector('[data-lens-strip="dom:b"]')?.textContent.includes('2 connected')`, 'honest connected count')
      if (await cdp.eval(`Boolean(document.querySelector('${card('app:b3')}'))`)) {
        throw new Error('unconnected app appeared in connected-only mode')
      }
      // The A side stays whole: the true source endpoint is not carded.
      if (await cdp.eval(`Boolean(document.querySelector('${card('app:a1')}'))`)) {
        throw new Error('focal-side endpoint carded before the focal was opened')
      }
    })
    await cdp.shot('e2e-domains-2-connected')

    await step('Show all reveals the rest, quiet', async () => {
      await click(cdp, `[data-lens-strip="dom:b"] button`, 'Show all toggle')
      await waitFor(cdp, `document.querySelector('${card('app:b3')}[data-lens-quiet]')`, 'quiet unconnected app')
    })
    await cdp.shot('e2e-domains-3-show-all')

    await step('chevron on an app nests its datasets three frames deep', async () => {
      await click(cdp, `${card('app:b1')} [aria-label="Open contents of app:b1"]`, 'app chevron')
      await waitFor(cdp, `document.querySelector('${card('ds:b1_orders')}')`, 'dataset 1')
      await waitFor(cdp, `document.querySelector('${card('ds:b1_lines')}')`, 'dataset 2')
      await waitFor(cdp, `document.querySelector('[data-lens-frame="app:b1"]')`, 'nested app frame')
    })
    await cdp.shot('e2e-domains-4-three-deep')

    await step('opening the focal cards its app and wires snap to it', async () => {
      await click(cdp, `${card('dom:a')} [aria-label="Open contents of dom:a"]`, 'focal chevron')
      await waitFor(cdp, `document.querySelector('${card('app:a1')}')`, 'A-side endpoint carded')
    })
    await cdp.shot('e2e-domains-5-a-side-open')

    await step('chevron on C auto-walks the pass-through tower', async () => {
      await click(cdp, `${card('dom:c')} [aria-label="Open contents of dom:c"]`, 'C chevron')
      await waitFor(cdp, `document.querySelector('${card('app:c1')}')`, 'deepest member')
      await waitFor(cdp, `document.querySelector('[data-lens-strip="dom:c"]')?.textContent.includes('PROD › CURATED')`, 'walked path named')
      if (await cdp.eval(`Boolean(document.querySelector('${card('dom:c_prod')}') || document.querySelector('${card('dom:c_curated')}'))`)) {
        throw new Error('pass-through intermediates were carded')
      }
    })
    await cdp.shot('e2e-domains-6-auto-walk')
  }
}

// ── Boot vite + chromium, run, verdict ─────────────────────────────────
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
const viteReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', d => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
  vite.stderr.on('data', d => { if (String(d).includes('is in use')) { clearTimeout(timer); reject(new Error(`Port ${PORT} busy — pkill -f "vite --port ${PORT}"`)) } })
})

const chrome = spawn(chromium, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' })

try {
  await viteReady
  let target
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find(t => t.type === 'page')
      if (target) break
    } catch { /* chrome still booting */ }
    await sleep(250)
  }
  if (!target) throw new Error('Chromium CDP target never appeared')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP socket failed')) })
  const cdp = new Cdp(ws)
  await drive(cdp, 'app')
  await drive(cdp, 'coarse')
  await drive(cdp, 'domains')
  await drive(cdp, 'columns')
  ws.close()
} catch (err) {
  failures++
  console.error(`harness-e2e: ${err.message}`)
} finally {
  chrome.kill('SIGKILL')
  vite.kill('SIGTERM')
}
console.log(failures === 0 ? '\nAll acceptance steps passed.' : `\n${failures} acceptance step(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
