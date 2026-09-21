/**
 * Fold distant layers, checked in the real app.
 *
 * jsdom does no layout, so none of what this feature is FOR is visible to
 * the unit suite: whether every layer actually fits, whether a line into a
 * folded layer really ends on its spine, whether a folded layer's rows
 * come back — containment and all — when it opens again.
 *
 *   node scripts/app-probe-fold.mjs [viewId] [--open <container>]
 *
 * Defaults to a view whose container-level lineage is materialized (its
 * AGGREGATED edges exist), so lines draw without drilling to columns. On a
 * data source whose aggregation has not run there is little to land.
 *
 * The throwaway profile is set to draw EVERY line: the product default
 * ('stubs') draws lines only for the hovered or selected entity, which on a
 * probe with nothing selected is no lines at all. Requires the dev stack up.
 */
import { connect, login, helpers, APP_ORIGIN } from './app-probe.mjs'

const argv = process.argv.slice(2)
const openFlag = argv.indexOf('--open')
/** A container in an OPEN layer whose children have lines into a folded one. */
const OPEN = openFlag >= 0 ? argv[openFlag + 1] : 'GOLD'
const VIEW = argv.filter((a, i) => !a.startsWith('--') && i !== openFlag + 1)[0] ?? 'view_bb534eb51e6d'

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

/** Everything the checks read, in one pass over the DOM. */
const STATE = `return (() => {
  const scroller = document.querySelector('[data-layer-id]')?.closest('.overflow-auto')
  const overlay = [...document.querySelectorAll('div')]
    .find(d => d.className === 'absolute inset-0 pointer-events-none z-[5]')
  const box = overlay?.getBoundingClientRect()
  // Each drawn line ends where the overlay put its endpoints: the start and
  // the end of its path. A line has several stroke layers; any will do.
  const ends = [...(overlay?.querySelectorAll('path') ?? [])].map(p => {
    const n = (p.getAttribute('d') ?? '').match(/-?\\d+(\\.\\d+)?/g)
    return n && n.length >= 4
      ? { sx: +n[0] + box.left, sy: +n[1] + box.top, tx: +n[n.length - 2] + box.left, ty: +n[n.length - 1] + box.top }
      : null
  }).filter(Boolean)
  const cols = [...document.querySelectorAll('[data-layer-id]')].map(col => {
    const r = col.getBoundingClientRect()
    const anchors = [...col.querySelectorAll('[data-fold-anchor]')].map(a => {
      const ar = a.getBoundingClientRect()
      const y = ar.top + ar.height / 2
      // A line lands on an anchor when its end sits just outside the spine's
      // edge at the anchor's height: 8px before the left edge (arriving),
      // 6px past the right (leaving) — where a line meets a card.
      const lands = ends.some(e =>
        (Math.abs(e.tx - (r.left - 8)) < 3 && Math.abs(e.ty - y) < 3) ||
        (Math.abs(e.sx - (r.right + 6)) < 3 && Math.abs(e.sy - y) < 3))
      return { name: a.getAttribute('data-label'), lands }
    })
    return {
      id: col.getAttribute('data-layer-id'),
      folded: col.hasAttribute('data-folded'),
      label: col.querySelector(':scope > [role=button]')?.getAttribute('aria-label') ?? null,
      width: Math.round(r.width),
      onScreen: r.left >= scroller.getBoundingClientRect().left - 1 && r.right <= scroller.getBoundingClientRect().right + 1,
      anchors,
      rows: [...col.querySelectorAll('[id^="layer-node-"]:not([data-fold-anchor])')].map(row => {
        const t = (row.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
        return { name: t[0], badge: t.find(x => /^\\+\\d+$/.test(x)) ?? null, chevron: !!row.querySelector('button') }
      }),
    }
  })
  return { overflow: scroller.scrollWidth - scroller.clientWidth, lines: ends.length, cols }
})()`

const { cdp, evalJs, goto, shot, waitForCanvas, close } = await connect()
try {
  await login(evalJs, goto)
  await evalJs(`
    const raw = localStorage.getItem('nexus-preferences')
    const p = raw ? JSON.parse(raw) : { state: {}, version: 7 }
    p.state.lineageRenderMode = 'raw'
    p.state.canvasFoldLayers = true
    p.state.canvasZoom = 1
    localStorage.setItem('nexus-preferences', JSON.stringify(p))
    localStorage.removeItem('nx-layer-widths')
    return true`)
  // Narrow enough that a four-layer view cannot show every layer open.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await goto(`${APP_ORIGIN}/views/${VIEW}`)
  await waitForCanvas()
  await settle(3000)
  const h = helpers(evalJs)

  let s = await evalJs(STATE)
  const folded = () => s.cols.filter(c => c.folded)
  check('some layers fold to fit', folded().length > 0, s.cols.map(c => c.folded ? `|${c.width}|` : `[${c.width}]`).join(' '))
  check('every layer is on screen — nothing scrolls sideways', s.overflow <= 1 && s.cols.every(c => c.onScreen), `overflow ${s.overflow}px`)
  check('spines share one width', new Set(folded().map(c => c.width)).size <= 1)

  // Every state below is checked for landing: whatever anchors a spine
  // holds, each must have its line drawn onto it.
  let anchorsSeen = 0
  const landing = (when) => {
    const anchors = folded().flatMap(c => c.anchors)
    anchorsSeen += anchors.length
    if (anchors.length === 0) return
    check(`${when}: lines into folded layers land on their spines`, anchors.every(a => a.lands),
      anchors.map(a => `${a.name}:${a.lands ? 'lands' : 'MISSING'}`).join(', '))
    check(`${when}: each such spine counts its lines`,
      folded().filter(c => c.anchors.length > 0).every(c => /lines? from the open layers/.test(c.label ?? '')))
  }
  landing('on load')

  // Open the container — from its spine first, if its layer is folded.
  const holder = folded().find(c => c.anchors.some(a => a.name === OPEN))
  if (holder) {
    await evalJs(`document.querySelector('[data-layer-id="${holder.id}"] > [role=button]').click(); return true`)
    await settle(2000)
    s = await evalJs(STATE)
    const opened = s.cols.find(c => c.id === holder.id)
    check('a click on a spine opens its layer', !opened.folded && opened.rows.some(r => r.name === OPEN),
      opened.rows.map(r => r.name).join(', '))
    check('...and the run still fits', s.overflow <= 1 && s.cols.every(c => c.onScreen), `overflow ${s.overflow}px`)
    landing('after opening a spine')
  }
  if (!await h.expand(OPEN)) throw new Error(`could not find "${OPEN}" to open`)
  await settle(2500)
  s = await evalJs(STATE)
  // The rows under OPEN in its own column — a container's children.
  const childrenOf = (state) => {
    const rows = state.cols.find(c => c.rows.some(r => r.name === OPEN))?.rows ?? []
    const at = rows.findIndex(r => r.name === OPEN)
    return at === -1 ? [] : rows.slice(at + 1)
  }
  const children = childrenOf(s)
  check(`${OPEN}'s children keep their containment controls`, children.length > 0 && children.every(r => r.chevron),
    `${children.length} children`)
  landing(`with ${OPEN} open`)
  await shot('/tmp/app-probe-fold-1.png')

  // Slide the window both ways; the open container must come back as it was.
  for (const [dir, label] of [['Previous layer', 'back'], ['Next layer', 'forward']]) {
    await evalJs(`const b = document.querySelector('[aria-label="${dir}"]'); if (b && !b.disabled) b.click(); return true`)
    await settle(2000)
    s = await evalJs(STATE)
    check(`stepping ${label} keeps the run on screen`, s.overflow <= 1 && s.cols.every(c => c.onScreen), `overflow ${s.overflow}px`)
    landing(`stepped ${label}`)
  }
  await shot('/tmp/app-probe-fold-2.png')
  const after = childrenOf(s)
  check('folding and opening again leaves containment as it was',
    after.length === children.length && after.every((r, i) => r.name === children[i].name && r.badge === children[i].badge),
    `${after.length} of ${children.length} children`)
  check('some line landed on a spine along the way', anchorsSeen > 0, `${anchorsSeen} anchors checked`)

  // Folding off: every layer opens and the canvas scrolls instead.
  await evalJs(`document.querySelector('[data-fold-toggle]')?.click(); return true`)
  await settle(1500)
  s = await evalJs(STATE)
  check('"Unfold all" opens every layer', s.cols.every(c => !c.folded), `overflow ${s.overflow}px`)
  await evalJs(`document.querySelector('[data-fold-toggle]')?.click(); return true`)
  await settle(1500)
  s = await evalJs(STATE)
  check('"Fold" folds them again', s.cols.some(c => c.folded) && s.overflow <= 1)
} finally {
  close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
