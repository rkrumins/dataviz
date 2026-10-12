/**
 * Walk lineage from the entity drawer, in the real app, and check the things
 * only a browser can answer.
 *
 * Every assertion here stands for a bug that SHIPPED past a green unit suite:
 *
 *   1. A container keeps its child-count badge and its controls after being
 *      opened from the drawer. It once lost them permanently, because the
 *      panel seeded a lean copy of the node and `addGraph` keeps the FIRST
 *      version of an id it is given — the real hydrated node could never
 *      land, and the container had no way to expand.
 *   2. Clicking a partner actually MOVES the drawer. It used to sit on the
 *      previous entity whenever the store could not resolve the new one,
 *      because `isOpen` is `!!selectedNode` — which reads as a dead click.
 *   3. Back and forward retrace that walk.
 *
 * None of these are visible to jsdom: they are about the shape a node has
 * after a real fetch, and about a panel resolving against a real store.
 *
 *   node scripts/app-probe-drawer.mjs [viewId] [spine...] [--leaf name] [--target name]
 *       [--deep-parent name]
 *
 * Defaults to the estate the reports came from. Requires the dev stack up.
 */
import { connect, login, helpers, listViews, APP_ORIGIN } from './app-probe.mjs'

const argv = process.argv.slice(2)
const leafFlag = argv.indexOf('--leaf')
const LEAF = leafFlag >= 0 ? argv[leafFlag + 1] : 'account_id'
const positional = (leafFlag >= 0 ? argv.slice(0, leafFlag) : argv).filter(a => !a.startsWith('--'))
const VIEW = positional[0] ?? 'view_23c1434ce3f3'
const SPINE = positional.length > 1
  ? positional.slice(1)
  : ['Snowflake', 'INTERMEDIATE_T1', 'int_clean_contacts_t1']
/** The container reached FROM the drawer — the one whose containment is the
 *  thing under test. Overridable with --target. */
const targetFlag = argv.indexOf('--target')
const TARGET = targetFlag >= 0 ? argv[targetFlag + 1] : 'INTERMEDIATE_T2'
/** The container that HOLDS the deep partner — several levels down, and
 *  collapsed, which is what makes the deep case a real walk. */
const deepFlag = argv.indexOf('--deep-parent')
const DEEP_PARENT = deepFlag >= 0 ? argv[deepFlag + 1] : 'int_clean_contacts_t2'

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { evalJs, goto, shot, waitForCanvas, close } = await connect()
try {
  await login(evalJs, goto)
  const views = await listViews(evalJs, goto)
  const view = views.find((v) => v.id === VIEW)
  console.log(`view ${VIEW}${view ? ` (${view.name})` : ''}\n`)

  await goto(`${APP_ORIGIN}/views/${VIEW}`)
  await waitForCanvas()
  const h = helpers(evalJs)

  for (const step of SPINE) {
    if (!await h.expand(step)) throw new Error(`could not find "${step}" to expand`)
  }
  if (!await h.clickRow(LEAF)) throw new Error(`could not find leaf "${LEAF}"`)

  const lines = await h.drawerLines()
  check('drawer opens on the clicked entity', lines?.[1] === LEAF, lines?.[1])

  // The partner rows live inside the direction cards, which start closed.
  // Opened by LABEL, never by the leading count: a count is not a selector —
  // "1" matches whatever button happens to start with it, which silently
  // clicks something else and makes every later lookup fail for a reason that
  // has nothing to do with the app.
  const opened = await evalJs(`
    const p = document.querySelector('[data-panel="entity-drawer"]')
    if (!p) return false
    const b = [...p.querySelectorAll('button')]
      .find(x => (x.innerText || '').includes('Data Consumers'))
    if (b) { b.scrollIntoView({ block: 'center' }); b.click() }
    return !!b`)
  check('the consumers card opens', opened)
  await new Promise((r) => setTimeout(r, 1500))

  // The container to open from the drawer, and its healthy shape beforehand.
  const before = await h.info(TARGET)
  if (!before) {
    check('baseline container is on the canvas', false, `"${TARGET}" not found`)
  } else {
    check('baseline container has its badge', before.text.some((t) => /^\+\d+$/.test(t)),
      before.text.join(' / '))

    const jumped = await h.clickDrawerButton(TARGET)
    check('clicking a partner is possible', jumped)

    const after = await h.info(TARGET)
    const drawerNow = (await h.drawerLines() ?? [])[1]

    check('the drawer MOVED to the partner', drawerNow === TARGET, drawerNow)
    check('containment survives the jump',
      !!after && after.text.some((t) => /^\+\d+$/.test(t)) && after.buttons >= 3,
      after ? after.text.join(' / ') : 'row gone')

    // Back / forward only exist once there is somewhere to go.
    const navLabels = () => evalJs(`
      const p = document.querySelector('[data-panel="entity-drawer"]')
      return p ? [...p.querySelectorAll('button')]
        .map(b => b.getAttribute('aria-label') || '')
        .filter(a => /previous entity|next entity/i.test(a)) : []`)
    check('the trail offers back and forward', (await navLabels()).length === 2)

    await evalJs(`
      const p = document.querySelector('[data-panel="entity-drawer"]')
      const b = [...p.querySelectorAll('button')]
        .find(x => /previous entity/i.test(x.getAttribute('aria-label') || ''))
      if (b) b.click(); return !!b`)
    await new Promise((r) => setTimeout(r, 2500))
    check('back returns to where the walk started',
      (await h.drawerLines() ?? [])[1] === LEAF, (await h.drawerLines() ?? [])[1])
  }

  // ── The DEEP case: a partner several levels inside a collapsed container.
  // This is the one that stayed broken longest. The reveal has to walk the
  // whole chain — and every ancestor arrives from /ancestors with
  // `childCount: null`, which the hydrator once read as "childless" and
  // skipped, so the walk stopped partway, the target never landed, and the
  // drawer closed itself.
  // Back has returned us to the leaf, but the drawer re-rendered on the way,
  // so its direction card is closed again.
  await evalJs(`
    const p = document.querySelector('[data-panel="entity-drawer"]')
    if (!p) return false
    const b = [...p.querySelectorAll('button')].find(x => (x.innerText || '').includes('Data Consumers'))
    if (b) { b.scrollIntoView({ block: 'center' }); b.click() }
    return !!b`)
  await new Promise((r) => setTimeout(r, 1500))

  const deepUrnBefore = await evalJs(`
    const p = document.querySelector('[data-panel="entity-drawer"]')
    const m = p ? (p.innerText || '').match(/urn:li:[^\\s]+/) : null
    return m ? m[0] : null`)

  const wentDeep = await evalJs(`
    const p = document.querySelector('[data-panel="entity-drawer"]')
    if (!p) return false
    const b = [...p.querySelectorAll('button')].find(x => {
      const t = x.innerText || ''
      return t.trim().startsWith(${JSON.stringify(LEAF)}) && t.includes(${JSON.stringify(DEEP_PARENT)})
    })
    if (b) { b.scrollIntoView({ block: 'center' }); b.click() }
    return !!b`)
  if (wentDeep) {
    await new Promise((r) => setTimeout(r, 7000))
    const deepUrnAfter = await evalJs(`
      const p = document.querySelector('[data-panel="entity-drawer"]')
      const m = p ? (p.innerText || '').match(/urn:li:[^\\s]+/) : null
      return m ? m[0] : null`)
    check('the drawer survives a deep jump',
      await evalJs(`return !!document.querySelector('[data-panel="entity-drawer"]')`))
    check('a deep jump moves to a DIFFERENT entity',
      !!deepUrnAfter && deepUrnAfter !== deepUrnBefore, `${deepUrnBefore} -> ${deepUrnAfter}`)
    check('the deep container tree is brought onto the canvas',
      !!await h.info(DEEP_PARENT), DEEP_PARENT)
  }

  const out = await shot('/tmp/app-probe-drawer.png')
  console.log(`\nscreenshot: ${out}`)
} finally {
  close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
