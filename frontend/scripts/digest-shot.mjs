/**
 * Screenshot "what changed since you last looked" and the watch toggles through the real browser:
 * the chip in the canvas versioning bar, the sheet in each state (with data, the last 7 days, cut
 * short, nothing new, loading, an error, after "Mark as seen"), and the toggles, against the
 * harness's in-memory API (`src/harness/digestHarness.tsx`). Drives Chromium over the DevTools
 * Protocol, as `versioned-graphs-shot.mjs` does, so a state can click its way there first.
 *
 *   node scripts/digest-shot.mjs [state[:dark][:phone] ...]
 *
 * With no arguments: every state, the main ones in light, dark and at phone width (360 px).
 * PNGs go to .harness/, or to SHOT_OUT.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5197
const CDP_PORT = 9334
const OUT = process.env.SHOT_OUT || '.harness'
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
}
true`

/** Each state: its harness query, what to wait for, and the clicks that get there. */
const STATES = {
    chip: { query: 'scenario=ok', wait: '3 new' },
    'chip-error': { query: 'scenario=error', wait: 'Couldn’t check what changed' },
    sheet: { query: 'scenario=ok&sheet=1', wait: 'Since your last visit' },
    // The end of the same sheet: the versions, scrolled to.
    'sheet-end': {
        query: 'scenario=ok&sheet=1', wait: 'Since your last visit',
        steps: [`__h.el('[role=dialog] .overflow-y-auto').scrollTop = 1e6`, 'wait:300'],
    },
    'sheet-week': { query: 'scenario=week&sheet=1', wait: 'The last 7 days' },
    'sheet-truncated': { query: 'scenario=truncated&sheet=1', wait: 'Showing the latest 50 of 214 versions' },
    'sheet-cut': { query: 'scenario=cut&sheet=1', wait: 'there are more' },
    'sheet-empty': { query: 'scenario=empty&sheet=1', wait: 'Nothing new since you last looked' },
    'sheet-loading': { query: 'scenario=loading&sheet=1', wait: 'What changed' },
    'sheet-error': { query: 'scenario=error&sheet=1', wait: 'Couldn’t load what changed' },
    'sheet-marked': {
        query: 'scenario=ok&sheet=1', wait: 'Since your last visit',
        steps: [`__h.click('[role=dialog] button', 'Mark as seen')`, 'wait:900'],
    },
    toggles: {
        query: 'scenario=empty', wait: 'Orders',
        steps: [`__h.click('button', 'Watch this graph')`, 'wait:600'],
    },
    'toggles-off': { query: 'scenario=empty', wait: 'Orders' },
}

const MAIN = ['chip', 'sheet', 'sheet-empty', 'sheet-truncated', 'toggles']
const DEFAULT_SHOTS = MAIN.flatMap((s) => [s, `${s}:dark`, `${s}:phone`])
    .concat(['sheet-end', 'sheet-end:dark', 'sheet-end:phone', 'sheet-week', 'sheet-cut', 'sheet-loading',
        'sheet-error', 'sheet-error:dark', 'chip-error', 'sheet-marked', 'sheet-marked:dark', 'toggles-off',
        'toggles-off:dark'])

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
    const profile = mkdtempSync(join(tmpdir(), 'digest-shot-'))
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
    const url = `http://localhost:${PORT}/digest-harness.html?${state.query}${dark ? '&theme=dark' : ''}`
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
    await sleep(400)
    const file = join(OUT, `digest-${shot.replace(/:/g, '-')}.png`)
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
