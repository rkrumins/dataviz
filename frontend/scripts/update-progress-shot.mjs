/**
 * Screenshot update progress through the real browser: the component in every state, and each place
 * it shows (the sync chip in both lenses with its card open, the refreshing badge, the read-route
 * chip, the fast read layer's card, a graph's drawer opening on its health), against the harness's
 * in-memory API (`src/harness/updateProgressHarness.tsx`). It drives Chromium over the DevTools
 * Protocol, as `versioned-graphs-shot.mjs` does, so a state can click its way there first.
 *
 *   node scripts/update-progress-shot.mjs [shot[:dark][:phone] ...]
 *
 * With no arguments: every shot, in light, dark and at phone width (360 px). PNGs go to
 * `SHOT_OUT` (default `.harness/`).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5217
const CDP_PORT = 9347
const OUT = process.env.SHOT_OUT || '.harness'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Each shot: its harness query, what to wait for, and the clicks that get there. */
const SHOTS = {
    states: { query: 'view=states', wait: 'every state' },
    'places-updating': { query: 'view=places&state=updating', wait: 'Health now' },
    'places-updating-card': {
        query: 'view=places&state=updating', wait: 'Health now', viewport: true,
        steps: [`document.querySelector('button[aria-label^="Sync status"]').click()`, 'wait:500'],
    },
    'places-updating-business': { query: 'view=places&state=updating&lens=business', wait: 'Health now' },
    'places-building': { query: 'view=places&state=building', wait: 'Health now' },
    'places-copying': { query: 'view=places&state=copying', wait: 'Health now' },
    'places-switching-card': {
        query: 'view=places&state=switching', wait: 'Health now', viewport: true,
        steps: [`document.querySelector('button[aria-label^="Sync status"]').click()`, 'wait:500'],
    },
    'places-seeding-business': { query: 'view=places&state=seeding&lens=business', wait: 'Health now' },
    'places-loading': { query: 'view=places&state=loading', wait: 'Health now' },
    'drawer-building': { query: 'view=drawer&state=building', wait: 'Health now', viewport: true },
}

const DEFAULT_SHOTS = ['states', 'places-updating', 'places-updating-card', 'places-updating-business', 'places-switching-card', 'drawer-building']
    .flatMap((s) => [s, `${s}:dark`, `${s}:phone`])
    .concat(['places-building', 'places-copying', 'places-seeding-business', 'places-loading:dark'])

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
    const profile = mkdtempSync(join(tmpdir(), 'up-shot-'))
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
    const state = SHOTS[name]
    if (!state) throw new Error(`no shot ${name}`)
    const dark = flags.includes('dark')
    const phone = flags.includes('phone')
    const width = phone ? 360 : 1280
    const height = phone ? 780 : 860
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: phone })
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/update-progress-harness.html?${state.query}${dark ? '&theme=dark' : ''}` })
    const deadline = Date.now() + 20_000
    for (;;) {
        const ready = await evalJs(`document.body && document.body.innerText.includes(${JSON.stringify(state.wait)})`).catch(() => false)
        if (ready) break
        if (Date.now() > deadline) throw new Error(`${shot}: "${state.wait}" never showed`)
        await sleep(200)
    }
    await sleep(700)
    for (const step of state.steps ?? []) {
        if (step.startsWith('wait:')) await sleep(Number(step.slice(5)))
        else await evalJs(step)
    }
    // No page may scroll sideways, at any width.
    const overflow = await evalJs('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    if (overflow > 0) console.warn(`  ! ${shot}: ${overflow}px of horizontal scroll`)
    if (!state.viewport) {
        const full = await evalJs('document.documentElement.scrollHeight')
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.min(full, phone ? 4200 : 4200), deviceScaleFactor: phone ? 2 : 1, mobile: phone })
        await sleep(500)
    }
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT, `update-progress-${shot.replace(/:/g, '-')}.png`)
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
