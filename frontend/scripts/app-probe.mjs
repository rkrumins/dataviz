/**
 * Drive the REAL app in a headless browser, over the DevTools Protocol.
 *
 * The unit suite cannot see the class of bug this exists for: a node that
 * renders with the wrong SHAPE because of what a real fetch returned, a
 * panel that silently shows the previous entity because the store could not
 * resolve the new one, a container that loses its expand control. Those are
 * all "looks fine in jsdom, wrong in Chrome" — jsdom does no layout, and a
 * fixture cannot model what the backend actually sends.
 *
 * No Playwright, no Puppeteer: Node 22+ has a global WebSocket, and Chrome's
 * own debugging protocol is enough. Adding a browser-automation dependency to
 * click four things would not be.
 *
 * The browser runs on a THROWAWAY profile. Never the developer's own — their
 * tabs, session and history are not this script's to touch.
 *
 *   import { connect, login, helpers } from './app-probe.mjs'
 *   const { evalJs, goto, shot, close } = await connect()
 *   await login(evalJs, goto)
 *
 * Requires the dev stack up (`./dev.sh`), which is where the credentials and
 * the frontend on :5173 come from.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'
/** The dev frontend. `:3000` is the FalkorDB Browser, which has its own login. */
export const APP_ORIGIN = 'http://localhost:5173'
// fileURLToPath, not `.pathname`: a repo path with a space arrives percent-encoded.
const ENV_FILE = fileURLToPath(new URL('../../.env.dev', import.meta.url))

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Already-running debug browser, or a fresh headless one on a scratch profile. */
async function ensureBrowser() {
  try {
    await fetch(`${CDP}/json/version`)
    return null
  } catch { /* not up yet */ }

  const bin = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!bin) {
    throw new Error(
      `No Chrome/Chromium found. Start one yourself with:\n` +
      `  <chrome> --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp>`,
    )
  }
  const profile = mkdtempSync(join(tmpdir(), 'app-probe-'))
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1100',
    'about:blank',
  ], { stdio: 'ignore', detached: true })
  child.unref()

  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try { await fetch(`${CDP}/json/version`); return child } catch { /* keep waiting */ }
  }
  throw new Error('Chrome did not open its debugging port')
}

export async function connect() {
  await ensureBrowser()
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
    ?? await (await fetch(`${CDP}/json/new?about:blank`)).json()

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  const events = []
  const listeners = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
    }
  }
  /** React to a CDP event as it arrives (`events` only records them). */
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(fn)
  }

  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} timed out`)) }
    }, 45_000)
  })

  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Network.enable')

  /**
   * Run an expression in the page and return its value.
   *
   * The body is wrapped in an async IIFE, so it needs an explicit `return` —
   * and a fragment that starts with a bare `const` is a syntax error. Build
   * fragments as whole statements rather than by gluing expressions together.
   * A page-side throw is re-thrown here with the page's own message, so a
   * broken selector never reads as an app failure.
   */
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('page threw: ' + (d.exception?.description ?? d.text))
    }
    return r.result?.value
  }

  const goto = async (url) => {
    await cdp('Page.navigate', { url })
    await sleep(1200)
    for (let i = 0; i < 60; i++) {
      if (await evalJs('return document.readyState') === 'complete') break
      await sleep(250)
    }
  }

  const shot = async (path) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  /** Wait until the canvas has painted rows, or give up and say so. */
  const waitForCanvas = async (timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = await evalJs(`return document.querySelectorAll('[id^="layer-node-"]').length`)
      if (n > 0) { await sleep(2000); return n }
      await sleep(500)
    }
    throw new Error('canvas never painted a row')
  }

  return { cdp, on, evalJs, goto, shot, waitForCanvas, close: () => ws.close(), events }
}

/**
 * Serve feature flags as a deployment with them switched on would — to THIS
 * browser only. The probe's browser reads `/api/v1/features/values` like any
 * client; the response is rewritten in flight. Flipping the flag through the
 * admin API instead would change the deployment for everyone using it.
 * Call before navigating.
 */
export async function overrideFeatures({ cdp, on }, values) {
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/features/values*', requestStage: 'Response' }] })
  on('Fetch.requestPaused', async (p) => {
    try {
      const { body, base64Encoded } = await cdp('Fetch.getResponseBody', { requestId: p.requestId })
      const json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body)
      json.values = { ...(json.values ?? {}), ...values }
      await cdp('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: p.responseStatusCode ?? 200,
        responseHeaders: p.responseHeaders,
        body: Buffer.from(JSON.stringify(json)).toString('base64'),
      })
    } catch {
      await cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {})
    }
  })
}

/**
 * Sign in FROM INSIDE THE PAGE.
 *
 * The backend's CSRF/origin check trusts `localhost:5173` and not
 * `127.0.0.1:5173`, and cookies injected through `Network.setCookie` drop the
 * HttpOnly lines — both land you back on /login looking like a bad password.
 */
export async function login(evalJs, goto) {
  const env = readFileSync(ENV_FILE, 'utf8')
  const pick = (k) =>
    (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')

  await goto(`${APP_ORIGIN}/login`)
  const status = await evalJs(`
    const r = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ${JSON.stringify(pick('ADMIN_EMAIL'))},
        password: ${JSON.stringify(pick('ADMIN_PASSWORD'))},
      }),
    })
    return r.status
  `)
  if (status !== 200) throw new Error(`login failed: HTTP ${status}`)
  // The redirect that follows destroys this execution context; anything
  // evaluated before the next navigation dies with "Failed to fetch".
  await goto(`${APP_ORIGIN}/dashboard`)
  return status
}

/**
 * Canvas helpers, all keyed on a row's FIRST TEXT LINE — the entity's name as
 * a reader sees it. Rows are virtualized, so everything scrolls the target
 * into view and clicks it IN THE PAGE: a coordinate click computed before a
 * scroll lands somewhere else and reads as "the button does nothing".
 */
export function helpers(evalJs) {
  const rowExpr = (name) => `
    const rows = [...document.querySelectorAll('[id^="layer-node-"]')]
    const row = rows.find(r => (r.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(name)})
  `
  return {
    /**
     * Open a container, IDEMPOTENTLY. The first button in a row is its
     * chevron, and a chevron TOGGLES — so clicking one that a restored
     * per-view expansion state had already opened closes it instead, and
     * every later lookup then fails for a reason that has nothing to do with
     * the app. Row count is the tell: opening adds rows, closing removes
     * them, so a shrink is undone.
     */
    async expand(name) {
      const count = () => evalJs(`return document.querySelectorAll('[id^="layer-node-"]').length`)
      const before = await count()
      const found = await evalJs(`${rowExpr(name)}
        if (row) { row.scrollIntoView({ block: 'center' }); row.querySelector('button')?.click() }
        return !!row`)
      if (!found) return false
      await sleep(2000)
      if (await count() < before) {
        await evalJs(`${rowExpr(name)}
          if (row) { row.scrollIntoView({ block: 'center' }); row.querySelector('button')?.click() }
          return true`)
        await sleep(2000)
      }
      return true
    },
    async clickRow(name) {
      const found = await evalJs(`${rowExpr(name)}
        if (row) { row.scrollIntoView({ block: 'center' }); row.click() }
        return !!row`)
      await sleep(1600)
      return found
    },
    /**
     * A row's visible lines plus its control count — a container that lost its
     * `+N` badge is a node that arrived in the store half-formed.
     *
     * The columns are VIRTUALIZED, so a row outside the window is not in the
     * DOM at all and a plain query cannot tell "absent" from "not painted".
     * This scrolls each column through its own height looking for the row
     * before reporting null, which is the difference between a real finding
     * and a false one.
     */
    async info(name) {
      const read = () => evalJs(`${rowExpr(name)}
        if (!row) return null
        return {
          text: (row.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean),
          buttons: row.querySelectorAll('button').length,
        }`)
      const first = await read()
      if (first) return first
      await evalJs(`
        for (const c of document.querySelectorAll('.custom-scrollbar')) c.scrollTop = 0
        return true`)
      await sleep(200)
      const fromTop = await read()
      if (fromTop) return fromTop

      // Step each column by most of its own height, so no window is skipped —
      // sampling a few fractions of a long column walks straight past rows.
      // Scroll positions are restored, because a probe that leaves the canvas
      // somewhere else changes what the NEXT check sees.
      const saved = await evalJs(`
        return [...document.querySelectorAll('.custom-scrollbar')].map(c => c.scrollTop)`)
      try {
        for (let pass = 0; pass < 30; pass++) {
          const more = await evalJs(`
            let moved = false
            for (const c of document.querySelectorAll('.custom-scrollbar')) {
              const max = c.scrollHeight - c.clientHeight
              if (c.scrollTop >= max - 1) continue
              c.scrollTop = Math.min(max, c.scrollTop + c.clientHeight * 0.8)
              moved = true
            }
            return moved`)
          await sleep(200)
          const found = await read()
          if (found) return found
          if (!more) break
        }
        return null
      } finally {
        await evalJs(`
          const tops = ${JSON.stringify(saved ?? [])}
          document.querySelectorAll('.custom-scrollbar').forEach((c, i) => {
            if (typeof tops[i] === 'number') c.scrollTop = tops[i]
          })
          return true`)
      }
    },
    rowNames() {
      return evalJs(`return [...document.querySelectorAll('[id^="layer-node-"]')]
        .map(r => (r.innerText || '').split('\\n')[0].trim())`)
    },
    drawerLines() {
      return evalJs(`
        const p = document.querySelector('[data-panel="entity-drawer"]')
        return p ? (p.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean) : null`)
    },
    /** Click a button inside the drawer whose text starts with `prefix`. */
    async clickDrawerButton(prefix) {
      const found = await evalJs(`
        const p = document.querySelector('[data-panel="entity-drawer"]')
        if (!p) return false
        const b = [...p.querySelectorAll('button')]
          .find(x => (x.innerText || '').trim().startsWith(${JSON.stringify(prefix)}))
        if (b) { b.scrollIntoView({ block: 'center' }); b.click() }
        return !!b`)
      await sleep(2500)
      return found
    },
  }
}

/** View ids are read from the DOM — `/api/v1/views` is not reachable from the page. */
export async function listViews(evalJs, goto) {
  await goto(`${APP_ORIGIN}/explorer`)
  await sleep(3500)
  return evalJs(`
    const seen = new Set()
    return [...document.querySelectorAll('a[href^="/views/"]')].map(a => {
      const parts = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      return { id: a.getAttribute('href').split('/').pop(), name: parts[1] ?? '' }
    }).filter(v => v.name && !seen.has(v.id) && seen.add(v.id))`)
}
