/**
 * Screenshot every Admin → Versioned graphs state through the real browser: the Overview, Settings
 * in both lenses, a Review with staged changes, History, a graph's settings drawer, and the states
 * a person can meet (an error, read-only, a fork, a workspace admin); then a workspace's Versioned
 * graphs tab (`ws-*`: its defaults within the platform's limits, a review, its graphs, its history)
 * and a data source's Versioning tab (`ds-*`: the settings summary and the drawer it opens), against
 * the harness's in-memory API (`src/harness/versionedGraphsHarness.tsx`).
 *
 * Unlike the other shot scripts it drives Chromium over the DevTools Protocol (as `app-probe.mjs`
 * does, without Playwright), because a review exists only after something is staged: each state
 * can click its way there first.
 *
 *   node scripts/versioned-graphs-shot.mjs [state[:dark][:phone] ...]
 *
 * With no arguments: every state, in light, dark and at phone width (360 px).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5198
const CDP_PORT = 9333
const OUT = '.harness'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Helpers the steps call in the page. */
const IN_PAGE = `
window.__h = {
  el(selector, text) {
    const all = [...document.querySelectorAll(selector)]
    const found = text === undefined ? all[0] : all.find((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().startsWith(text))
    if (!found) throw new Error('nothing matches ' + selector + ' ' + (text ?? ''))
    return found
  },
  click(selector, text) { this.el(selector, text).click(); return true },
  type(selector, value) {
    const input = this.el(selector)
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
}
true`

/** Each state: its harness query, what to wait for, and the clicks that get there. */
const STATES = {
    overview: { query: 'tab=overview', wait: 'Every versioned graph' },
    // The list on its own: at phone width the whole Overview is taller than a capture.
    inventory: { query: 'tab=overview', wait: 'Every versioned graph', scrollTo: '#inventory-title' },
    'settings-business': { query: 'tab=settings&lens=business', wait: 'What your settings trade' },
    'settings-operator': { query: 'tab=settings&lens=operator', wait: 'What your settings trade' },
    'settings-residency': { query: 'tab=settings&lens=operator', hash: '#residency-unloadstartpct', wait: 'What your settings trade', scrollTo: '#category-residency' },
    review: {
        query: 'tab=settings&lens=operator', wait: 'What your settings trade', viewport: true,
        steps: [
            `__h.click('#reads-mode [role=radio]', 'Keep serving, update in place')`,
            // Narrow what workspaces and graphs may choose, so the review lists the values left outside.
            `__h.click('#reads-mode label', 'Always the latest')`,
            `__h.click('#builds-forrebuilds [role=switch]')`,
            'wait:800',
            `__h.click('button', 'Review changes')`,
            'wait:600',
            `__h.type('[role=dialog] textarea', 'Large imports were slowing canvases for the sales team')`,
            'wait:400',
        ],
    },
    // The end of the same review: the warning to acknowledge and the reason.
    'review-end': { query: 'tab=settings&lens=operator', wait: 'What your settings trade', viewport: true, steps: [] },
    history: { query: 'tab=history', wait: 'Every change, with why' },
    drawer: { query: 'tab=overview&drawer=1&scenario=workspace-admin', wait: 'Health now', viewport: true },
    'drawer-fork': { query: 'tab=overview&drawer=1&scenario=fork', wait: 'This graph is a fork', viewport: true },
    error: { query: 'tab=settings&scenario=error', wait: 'Couldn’t read' },
    'overview-error': { query: 'tab=overview&scenario=error', wait: 'Couldn’t list' },
    readonly: { query: 'tab=settings&scenario=readonly&lens=business', wait: 'You can read these settings' },
    empty: { query: 'tab=history&scenario=empty', wait: 'No changes yet' },

    // A workspace's Versioned graphs tab: its defaults (a workspace admin, unless the scenario says otherwise), graphs and history.
    'ws-defaults': { query: 'page=workspace&scenario=workspace-admin&lens=business', wait: 'What your settings trade' },
    'ws-defaults-operator': { query: 'page=workspace&scenario=workspace-admin&lens=operator', wait: 'What your settings trade' },
    'ws-limits': { query: 'page=workspace&scenario=workspace-admin&lens=operator', hash: '#reads-mode', wait: 'What your settings trade', scrollTo: '#reads-mode' },
    'ws-platform-wide': { query: 'page=workspace&scenario=workspace-admin&lens=operator', wait: 'What your settings trade', scrollTo: '#category-builds' },
    'ws-review': {
        query: 'page=workspace&scenario=workspace-admin&lens=operator', wait: 'What your settings trade', viewport: true,
        steps: [
            `__h.click('#reads-mode [role=radio]', 'Always the latest')`,
            `__h.click('#trash-restoredays button', 'Use recommended')`,
            'wait:800',
            `__h.click('button', 'Review changes')`,
            'wait:600',
            `__h.type('[role=dialog] textarea', 'Nightly imports were slowing the finance canvases')`,
            'wait:400',
        ],
    },
    'ws-graphs': { query: 'page=workspace&tab=graphs&scenario=workspace-admin', wait: 'This workspace’s graphs' },
    'ws-history': { query: 'page=workspace&tab=history&scenario=workspace-admin', wait: 'Every change, with why' },
    'ws-readonly': { query: 'page=workspace&scenario=readonly&lens=business', wait: 'You can read this workspace’s settings' },
    'ws-system-admin': { query: 'page=workspace&scenario=ok&lens=business', wait: 'As a system admin', scrollTo: '#category-residency' },
    'ws-error': { query: 'page=workspace&scenario=error', wait: 'Couldn’t read' },
    'ws-loading': { query: 'page=workspace&scenario=loading', wait: 'The defaults this workspace' },
    'ws-graphs-empty': { query: 'page=workspace&tab=graphs&scenario=empty', wait: 'No versioned graphs here yet' },

    // A data source's Versioning tab: the settings summary, where the graph lives, and the drawer opened from the summary.
    'ds-tab': { query: 'page=datasource&scenario=workspace-admin', wait: 'Values it doesn’t set come from its workspace' },
    'ds-drawer': {
        query: 'page=datasource&scenario=workspace-admin', wait: 'Values it doesn’t set come from its workspace', viewport: true,
        steps: [`__h.click('button', 'Open settings')`, 'wait:1800'],
    },
    'ds-fork': { query: 'page=datasource&scenario=fork', wait: 'This graph is a fork' },
    'ds-error': { query: 'page=datasource&scenario=error', wait: 'Couldn’t read this graph’s settings' },
}

STATES['review-end'].steps = [
    ...STATES.review.steps,
    `__h.el('[role=dialog] .overflow-y-auto').scrollTop = 1e6`,
    'wait:300',
]

const DEFAULT_SHOTS = ['overview', 'settings-business', 'settings-operator', 'review', 'history', 'drawer', 'error']
    .flatMap((s) => [s, `${s}:dark`, `${s}:phone`])
    .concat(['inventory:phone', 'review-end', 'settings-residency', 'drawer-fork', 'overview-error', 'readonly', 'empty'])
    .concat(['ws-defaults', 'ws-graphs', 'ws-history', 'ws-review', 'ds-tab', 'ds-drawer'].flatMap((s) => [s, `${s}:dark`, `${s}:phone`]))
    .concat(['ws-defaults-operator', 'ws-limits', 'ws-platform-wide', 'ws-readonly', 'ws-system-admin', 'ws-error', 'ws-loading', 'ws-graphs-empty',
        'ds-fork', 'ds-error'])

function findChromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
    if (!existsSync(root)) return null
    for (const dir of readdirSync(root)) {
        if (!dir.startsWith('chromium-')) continue
        for (const build of ['chrome-linux', 'chrome-linux64']) {
            const p = join(root, dir, build, 'chrome')
            if (existsSync(p)) return p
        }
    }
    return null
}

async function startVite() {
    const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
        vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
        vite.stderr.on('data', (d) => {
            if (String(d).includes('is in use')) { clearTimeout(timer); reject(new Error(`Port ${PORT} is in use: pkill -f "vite --port ${PORT}"`)) }
        })
    })
    return vite
}

async function startChromium(bin) {
    const profile = mkdtempSync(join(tmpdir(), 'vg-shot-'))
    const chrome = spawn(bin, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore', detached: true })
    for (let i = 0; i < 60; i++) {
        await sleep(250)
        try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return chrome } catch { /* not yet */ }
    }
    throw new Error('Chromium did not open its debugging port')
}

async function connect() {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data)
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        }
    }
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const mid = ++id
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
    })
    const evalJs = async (expression) => {
        const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result?.value
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    return { cdp, evalJs, close: () => ws.close() }
}

async function shoot({ cdp, evalJs }, shot) {
    const [name, ...flags] = shot.split(':')
    const state = STATES[name]
    if (!state) throw new Error(`no state ${name}`)
    const dark = flags.includes('dark')
    const phone = flags.includes('phone')
    const width = phone ? 360 : 1440
    const height = phone ? 780 : 900
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: phone })
    const url = `http://localhost:${PORT}/versioned-graphs-harness.html?${state.query}${dark ? '&theme=dark' : ''}${state.hash ?? ''}`
    await cdp('Page.navigate', { url })
    const deadline = Date.now() + 20_000
    for (;;) {
        const ready = await evalJs(`document.body && document.body.innerText.includes(${JSON.stringify(state.wait)})`).catch(() => false)
        if (ready) break
        if (Date.now() > deadline) throw new Error(`${shot}: "${state.wait}" never showed`)
        await sleep(200)
    }
    await sleep(600)
    await evalJs(IN_PAGE)
    for (const step of state.steps ?? []) {
        if (step.startsWith('wait:')) await sleep(Number(step.slice(5)))
        else await evalJs(step)
    }
    if (state.scrollTo) await evalJs(`document.querySelector(${JSON.stringify(state.scrollTo)})?.scrollIntoView({ block: 'start' }); true`)
    await sleep(400)
    const file = join(OUT, `versioned-graphs-${shot.replace(/:/g, '-')}.png`)
    if (!state.viewport && !state.scrollTo) {
        // The whole page (up to a cap), by growing the window to it: a capture beyond the window
        // paints the list's positioned rows where they were before it grew.
        const full = await evalJs('document.documentElement.scrollHeight')
        await cdp('Emulation.setDeviceMetricsOverride', {
            width, height: Math.min(full, phone ? 3600 : 4200), deviceScaleFactor: phone ? 2 : 1, mobile: phone,
        })
        await sleep(700)
    }
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log('  ✓', file)
}

const bin = findChromium()
if (!bin) {
    console.error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.')
    process.exit(1)
}
mkdirSync(OUT, { recursive: true })
const shots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SHOTS
const vite = await startVite()
const chrome = await startChromium(bin)
let failed = 0
try {
    const page = await connect()
    for (const shot of shots) {
        try { await shoot(page, shot) } catch (e) { failed += 1; console.error('  ✗', shot, e.message) }
    }
    page.close()
} finally {
    try { process.kill(-chrome.pid, 'SIGTERM') } catch { /* gone */ }
    try { process.kill(-vite.pid, 'SIGTERM') } catch { /* gone */ }
}
process.exit(failed ? 1 : 0)
