/**
 * Ghost cues, checked in the real app: how the canvas says there is lineage
 * it cannot draw — because the far end is scrolled out of sight (a PORTAL at
 * the viewport's edge, naming where it goes), or because the far end was
 * never loaded (a STUB beside the row, with the count and a way to bring the
 * entities in). See `ghostCues.tsx`.
 *
 * Both depend on layout, which jsdom does not do.
 *
 *   node scripts/app-probe-ghosts.mjs [viewId] [--open <container>]
 *
 * Runs twice: with the defaults (nothing folds, nothing rolls up — the
 * product as it ships), then with `canvasLineageRollupEnabled` switched on
 * for THIS browser only, where lines to unloaded entities roll up and the
 * stubs give way. Requires the dev stack up.
 */
import { connect, login, helpers, overrideFeatures, APP_ORIGIN } from './app-probe.mjs'

const argv = process.argv.slice(2)
const openFlag = argv.indexOf('--open')
const OPEN = openFlag >= 0 ? argv[openFlag + 1] : 'Snowflake'
const VIEW = argv.filter((a, i) => !a.startsWith('--') && i !== openFlag + 1)[0] ?? 'view_23c1434ce3f3'

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

const STATE = `return (() => {
  const sc = document.querySelector('[data-layer-id]')?.closest('.overflow-auto')
  const box = sc.getBoundingClientRect()
  const inside = r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
  const stubs = [...document.querySelectorAll('[data-off-canvas-stub]')].map(b => {
    const r = b.getBoundingClientRect()
    return { side: b.getAttribute('data-off-canvas-stub'), count: Number((b.innerText || '').replace(/[^0-9.]/g, '')) || 0, inside: inside(r) }
  })
  return {
    scrollLeft: sc.scrollLeft,
    overflow: sc.scrollWidth - sc.clientWidth,
    folded: document.querySelectorAll('[data-folded]').length,
    portals: [...document.querySelectorAll('[data-portal]')].map(b => ({ dir: b.getAttribute('data-portal'), text: (b.innerText || '').trim() })),
    stubs,
    stubTotal: stubs.reduce((n, s) => n + s.count, 0),
    columns: [...document.querySelectorAll('[data-layer-id]')].map(c => {
      const r = c.getBoundingClientRect()
      return { name: (c.querySelector('.sticky')?.innerText || '').split('\\n')[0].trim(), visible: r.right > box.left + 40 && r.left < box.right - 40 }
    }),
  }
})()`

const storeNodes = `
  const url = performance.getEntriesByType('resource').map(e => e.name).find(n => /\\/src\\/store\\/canvas\\.ts/.test(n))
  const m = await import(url)
  return m.useCanvasStore.getState().nodes.length`

const conn = await connect()
const { cdp, evalJs, goto, shot, waitForCanvas, close, events } = conn
try {
  await login(evalJs, goto)
  await evalJs(`
    const raw = localStorage.getItem('nexus-preferences')
    const p = raw ? JSON.parse(raw) : { state: {} }
    p.state.lineageRenderMode = 'raw'
    p.state.canvasZoom = 1
    p.state.canvasFoldLayers = false
    localStorage.setItem('nexus-preferences', JSON.stringify(p))
    return true`)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  const h = helpers(evalJs)
  const chainCalls = () => events.filter(e => e.method === 'Network.requestWillBeSent' && /ancestor-chains/.test(e.params.request.url)).length

  // ── As it ships ─────────────────────────────────────────────────────────
  events.length = 0
  await goto(`${APP_ORIGIN}/views/${VIEW}`)
  await waitForCanvas()
  await settle(2500)
  if (!await h.expand(OPEN)) throw new Error(`could not find "${OPEN}" to open`)
  await settle(3500)
  let s = await evalJs(STATE)
  check('nothing folds by default — every layer at full width, the canvas scrolls', s.folded === 0 && s.overflow > 0, `overflow ${s.overflow}px`)
  check('no roll-up requests while the roll-up is off', chainCalls() === 0, `${chainCalls()} calls`)

  const portal = s.portals[0]
  const hidden = s.columns.filter(c => !c.visible).map(c => c.name)
  check('lineage to a layer out of sight ends at a portal that names it',
    !!portal && hidden.some(name => portal.text.includes(name)), s.portals.map(p => `${p.dir}: ${p.text}`).join(' | '))
  check('rows with lineage to entities not loaded carry a stub, inside the viewport',
    s.stubs.length > 0 && s.stubs.every(x => x.inside && x.count > 0), s.stubs.map(x => `${x.side}:${x.count}`).join(' '))
  await shot('/tmp/app-probe-ghosts-1.png')

  // A portal takes you there. Checked BEFORE a stub brings entities in:
  // once their containers open, the summary edge behind this portal gives
  // way to finer ones on rows further down, and the portal rightly goes.
  if (portal) {
    const before = s.scrollLeft
    const target = hidden.find(name => portal.text.includes(name))
    await evalJs(`[...document.querySelectorAll('[data-portal]')].find(b => (b.innerText || '').includes(${JSON.stringify(target ?? '')}))?.click(); return true`)
    await settle(2500)
    s = await evalJs(STATE)
    check('a portal click scrolls its layer into view',
      s.scrollLeft !== before && s.columns.some(c => c.name === target && c.visible), `scrollLeft ${before} → ${s.scrollLeft}`)
  }

  // Back to the start, and a stub brings its entities in: the store grows
  // and the counts go down.
  await evalJs(`document.querySelector('[data-layer-id]').closest('.overflow-auto').scrollTo({ left: 0, behavior: 'auto' }); return true`)
  await settle(1500)
  s = await evalJs(STATE)
  const nodesBefore = await evalJs(storeNodes)
  const totalBefore = s.stubTotal
  await evalJs(`document.querySelector('[data-off-canvas-stub]')?.click(); return true`)
  // A batch lands over several seconds: wait until the store stops growing.
  let nodesAfter = nodesBefore
  for (let quiet = 0, i = 0; quiet < 3 && i < 40; i++) {
    await settle(700)
    const n = await evalJs(storeNodes)
    quiet = n === nodesAfter ? quiet + 1 : 0
    nodesAfter = n
  }
  s = await evalJs(STATE)
  check('a stub click brings its entities onto the canvas', nodesAfter > nodesBefore, `${nodesBefore} → ${nodesAfter} nodes`)
  check('...and the stub counts go down as they land', s.stubTotal < totalBefore, `${totalBefore} → ${s.stubTotal}`)

  await shot('/tmp/app-probe-ghosts-2.png')

  // ── With roll-ups switched on, for this browser only ───────────────────
  await overrideFeatures(conn, { canvasLineageRollupEnabled: true })
  events.length = 0
  await goto(`${APP_ORIGIN}/views/${VIEW}`)
  await waitForCanvas()
  await settle(2500)
  await h.expand(OPEN)
  await settle(4500)
  s = await evalJs(STATE)
  check('with the roll-up on, the chains are asked for', chainCalls() > 0, `${chainCalls()} calls`)
  check('...and fewer lines are left without a place on the canvas', s.stubTotal < totalBefore, `stub total ${totalBefore} → ${s.stubTotal}`)
  await shot('/tmp/app-probe-ghosts-3.png')
} finally {
  close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
