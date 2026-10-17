/**
 * Capture the User Guide's product screenshots from the REAL app.
 *
 * The guide's pictures went stale every time a screen changed, because
 * retaking them meant clicking through dozens of states by hand. This drives
 * the running app over the DevTools Protocol instead (see `app-probe.mjs`):
 * one entry per shot — a name, a route, and the steps that put the screen in
 * the state the guide describes — so a reshoot is one command.
 *
 *   node scripts/guide-shots.mjs [outDir] [shot-name ...]
 *
 * `outDir` defaults to `.harness/guide-shots` (git-ignored); name shots
 * (file names without `.png`, as the pages' screenshot markers name them) to
 * take only those. Every shot is 1440×900 at device scale 1, light theme,
 * taken once the screen has stopped loading. Copy the ones you want into
 * `public/docs-assets/guide/`.
 *
 * Requires the dev stack up with the demo data onboarded — the data names the
 * shots rely on are the constants below — and `.env.dev` holding the admin
 * credentials (`login()` reads them from there). The two "no access" shots
 * also need VIEWER_EMAIL / VIEWER_PASSWORD there: a workspace viewer.
 * `versioning-change-control-enable` turns version control on, so it works
 * once per data source; `troubleshooting-state-card` answers graph reads with
 * 504 in this browser only, for that shot only.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, login, helpers, listViews, APP_ORIGIN } from './app-probe.mjs'

const [outArg, ...only] = process.argv.slice(2)
const OUT = resolve(outArg ?? '.harness/guide-shots')

// The demo data the shots are staged on.
const CONTEXT_VIEW = 'Revenue Reporting Lineage'
const CONTAINER = 'GOLD'
const ENTITY = 'fact_revenue'
const MORE_ENTITIES = ['fact_orders', 'dim_customer']
const EDIT_ENTITY = 'fact_orders'
const REVIEW_TITLE = 'Document the recognised revenue fact table'
const WORKSPACE = 'Enterprise Data Platform'
const UNVERSIONED_VIEW = 'Campaign Attribution Pipeline' // its data source is not under version control yet

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Visible element whose text starts with `text`, clicked in the page; false if absent. */
const clickText = (evalJs, text, scope = 'body', sel = 'button, a, [role="tab"]') => evalJs(`
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const els = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll(${JSON.stringify(sel)}) ?? [])].filter(vis)
  const el = els.find((e) => norm(e.innerText) === ${JSON.stringify(text)})
    ?? els.find((e) => norm(e.innerText).startsWith(${JSON.stringify(text)}))
  if (el) { el.scrollIntoView({ block: 'center' }); el.click() }
  return !!el`)

/**
 * A real pointer click at an element's centre. Radix tabs switch on
 * pointerdown, so an in-page `.click()` lands but changes nothing.
 */
async function pointerClick({ cdp, evalJs }, text, scope) {
  const at = await evalJs(`
    const els = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button, [role="tab"]') ?? [])]
    const el = els.find((e) => (e.innerText || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
  if (!at) throw new Error(`no "${text}" in ${scope}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 })
  }
  await sleep(800)
}

/** Type into the field with this placeholder the way a person would (React sees real input). */
async function typeInto({ cdp, evalJs }, placeholder, text) {
  const found = await evalJs(`
    const el = [...document.querySelectorAll('input, textarea')].find((e) => e.placeholder === ${JSON.stringify(placeholder)})
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select() }
    return !!el`)
  if (!found) throw new Error(`no field "${placeholder}"`)
  await cdp('Input.insertText', { text })
  await sleep(400)
}

/**
 * Open a container row, idempotently, by its chevron. Not `helpers().expand`:
 * in edit mode a row's first button is its "Drag to connect" handle. The
 * chevron's wrapper is rotated once the row is open.
 */
async function expandRow(evalJs, name) {
  const found = await evalJs(`
    const row = [...document.querySelectorAll('[id^="layer-node-"]')]
      .find((r) => (r.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(name)})
    const chevron = row?.querySelector('svg.lucide-chevron-right')
    if (!chevron) return false
    row.scrollIntoView({ block: 'center' })
    if (getComputedStyle(chevron.parentElement).transform === 'none') chevron.closest('button').click()
    return true`)
  if (!found) throw new Error(`no row "${name}"`)
  await sleep(2000)
}

/** Ctrl-click a canvas row: adds it to the selection, as a person would. */
const ctrlClickRow = (evalJs, name) => evalJs(`
  const row = [...document.querySelectorAll('[id^="layer-node-"]')]
    .find((r) => (r.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(name)})
  if (row) { row.scrollIntoView({ block: 'center' }); row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) }
  return !!row`)

/**
 * Wait until nothing is loading — no spinners, no skeleton blocks — and stays
 * that way for two polls. Small pulsing dots are live-status indicators, not
 * loading, so only pulses bigger than an icon count.
 */
async function settle(evalJs, timeoutMs = 20_000) {
  const busy = `return [...document.querySelectorAll('.animate-spin, .animate-pulse, [aria-busy="true"]')]
    .filter((e) => { const r = e.getBoundingClientRect()
      return r.width > 0 && (e.classList.contains('animate-spin') || r.width > 24) }).length`
  const deadline = Date.now() + timeoutMs
  let quiet = 0
  while (Date.now() < deadline && quiet < 2) {
    quiet = (await evalJs(busy)) === 0 ? quiet + 1 : 0
    await sleep(500)
  }
  await sleep(800)
}

/**
 * Collapse or expand the left navigation, through the same stored preference
 * the app reads at load. Canvas shots collapse it: at 1440px wide, the canvas
 * toolbar is too cramped beside it, and its controls draw over each other.
 */
const setSidebar = (evalJs, collapsed) => evalJs(`
  const p = JSON.parse(localStorage.getItem('nexus-preferences') ?? '{"state":{}}')
  p.state.sidebarCollapsed = ${collapsed}
  localStorage.setItem('nexus-preferences', JSON.stringify(p))
  return true`)

/** Open the Context View with the trace container expanded and the entity selected. */
async function openCanvas(ctx, select = ENTITY) {
  await setSidebar(ctx.evalJs, true)
  await ctx.goto(`${APP_ORIGIN}/views/${ctx.viewId(CONTEXT_VIEW)}`)
  await ctx.waitForCanvas()
  await expandRow(ctx.evalJs, CONTAINER)
  if (select) await ctx.h.clickRow(select)
}

async function startTrace(ctx) {
  if (!await clickText(ctx.evalJs, 'Trace Lineage', 'main')) throw new Error('no Trace Lineage button')
  await sleep(5000)
}

/** Enter edit mode on the existing draft (or start one), with GOLD open and nothing left staged. */
async function enterDraft(ctx) {
  await openCanvas(ctx, null)
  await clickText(ctx.evalJs, 'Edit', 'main'); await sleep(1500)
  // Re-enter the existing draft rather than starting a branch per run.
  const resumed = await ctx.evalJs(`
    const heading = [...document.querySelectorAll('p')].find((p) => p.innerText.trim().toLowerCase() === 'continue a draft')
    const first = heading?.nextElementSibling?.querySelector('button')
    if (first) first.click()
    return !!first`)
  if (!resumed) await clickText(ctx.evalJs, 'Create & edit')
  await sleep(4000)
  await ctx.waitForCanvas()
  // An edit left staged by an interrupted run comes back as "Restored … from your
  // last session"; start from nothing, or the same edit typed again changes nothing.
  await clickText(ctx.evalJs, 'Discard all', 'main'); await sleep(1500)
  await expandRow(ctx.evalJs, CONTAINER)
}

/** Open the entity's drawer on its Edit tab and change its Description. */
async function editDescription(ctx) {
  await ctx.h.clickRow(EDIT_ENTITY)
  await pointerClick(ctx, 'Edit', '[data-panel="entity-drawer"]')
  await typeInto(ctx, 'What is this, and what is it for?',
    'One row per order line, joined to customer and product. Feeds the revenue and fulfilment marts.')
}

/** Leave the draft as it was: drop staged edits, then leave edit mode. */
async function leaveDraft(ctx) {
  await clickText(ctx.evalJs, 'Cancel', '[data-panel="entity-drawer"]'); await sleep(800)
  await clickText(ctx.evalJs, 'Review & Save', 'main'); await sleep(1500)
  await clickText(ctx.evalJs, 'Discard all'); await sleep(1500)
  await clickText(ctx.evalJs, 'Done', 'main'); await sleep(1000)
}

async function openReviews(ctx) {
  await ctx.goto(`${APP_ORIGIN}/workspaces/${ctx.wsId}/reviews`)
  await settle(ctx.evalJs)
}

/** The Invite by link wizard, from Administration → Users. */
async function openInvite(ctx) {
  if (!await clickText(ctx.evalJs, 'Invite by Link', 'main')) throw new Error('no Invite by Link button')
  await sleep(2000)
}

// One entry per guide image: the file name, where it lives, and what puts it on screen.
// `as: 'viewer'` takes the shot signed in as VIEWER_EMAIL from .env.dev (a workspace viewer).
const SHOTS = [
  // The heroes the guide pages already show.
  { name: 'browsing-views-hero', route: '/explorer' },
  { name: 'semantic-layer-hero', route: '/schema' },
  { name: 'admin-infrastructure-hero', route: '/admin/overview' },
  {
    name: 'reading-lineage-hero',
    async setup(ctx) {
      await openCanvas(ctx); await startTrace(ctx)
      await clickText(ctx.evalJs, 'Expand', 'main'); await sleep(1500) // the trace dock, opened up
    },
  },
  // Start here.
  { name: 'quick-start-dashboard', route: '/dashboard' },
  {
    // The page a first sign-in with a published default password is sent to; it
    // renders the same form when opened directly. Filled in, never submitted.
    name: 'setup-new-password',
    route: '/password-change-required',
    async setup(ctx) {
      const fields = ['current-password-here', 'Harbour-Lantern-Tide-42', 'Harbour-Lantern-Tide-42']
      for (const [i, text] of fields.entries()) {
        await ctx.evalJs(`document.querySelectorAll('input[type="password"]')[${i}]?.focus(); return true`)
        await ctx.cdp('Input.insertText', { text }); await sleep(300)
      }
    },
  },
  // Viewers.
  {
    name: 'browsing-views-preview',
    route: '/explorer',
    async setup(ctx) {
      // A card opens its preview; the title is a link to the view itself, so click the description.
      const clicked = await ctx.evalJs(`
        const t = [...document.querySelectorAll('main p, main span')].find((e) => e.textContent.trim().startsWith('How revenue figures flow'))
        t?.click(); return !!t`)
      if (!clicked) throw new Error(`no card for "${CONTEXT_VIEW}"`)
      await sleep(2500)
    },
  },
  {
    name: 'browsing-views-favorites',
    route: '/explorer',
    async setup(ctx) {
      await ctx.evalJs(`document.querySelector('button[title*="favorite view"]')?.click(); return true`)
      await sleep(1500)
    },
  },
  { name: 'exploring-graph-trace', async setup(ctx) { await openCanvas(ctx); await startTrace(ctx) } },
  {
    name: 'exploring-graph-multi-select',
    async setup(ctx) {
      await openCanvas(ctx)
      for (const name of MORE_ENTITIES) { await ctrlClickRow(ctx.evalJs, name); await sleep(800) }
    },
  },
  {
    name: 'exploring-graph-display',
    async setup(ctx) {
      await openCanvas(ctx, null)
      if (!await clickText(ctx.evalJs, 'Display', 'main')) throw new Error('no Display button')
      await sleep(1200)
    },
  },
  {
    name: 'lineage-lens-hero',
    async setup(ctx) {
      await openCanvas(ctx)
      if (!await clickText(ctx.evalJs, 'Focus Lens', 'main')) throw new Error('no Focus Lens button')
      await sleep(4000)
    },
  },
  // Builders and reviewers.
  {
    name: 'creating-views-layout-step',
    route: '/explorer',
    async setup(ctx) {
      await clickText(ctx.evalJs, 'New View', 'main'); await sleep(2000)
      await clickText(ctx.evalJs, 'Next'); await sleep(1500) // Scope: the data source is preselected
      await typeInto(ctx, 'e.g., Finance Data Lineage', 'Order to Cash Lineage')
      await clickText(ctx.evalJs, 'Next'); await sleep(1500)
      // The step keeps the previous step's scroll position; start it at the top.
      await ctx.evalJs(`for (const e of document.querySelectorAll('*')) if (e.scrollTop > 0 && e.scrollHeight > e.clientHeight) e.scrollTop = 0; return true`)
    },
  },
  {
    name: 'editing-in-a-draft-edit-mode',
    async setup(ctx) {
      await enterDraft(ctx); await editDescription(ctx)
      await clickText(ctx.evalJs, 'Stage changes', '[data-panel="entity-drawer"]'); await sleep(1000)
      await ctx.evalJs(`document.querySelector('button[aria-label="Close entity details"]')?.click(); return true`)
      await sleep(1000)
    },
    cleanup: leaveDraft,
  },
  {
    name: 'editing-in-a-draft-stage-bar',
    async setup(ctx) {
      await enterDraft(ctx); await editDescription(ctx)
      // Rest the pointer on Stage changes, so its tip shows the shortcut.
      const at = await ctx.evalJs(`
        const b = [...document.querySelector('[data-panel="entity-drawer"]').querySelectorAll('button')]
          .find((e) => e.innerText.trim() === 'Stage changes')
        const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
      await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
      await sleep(1200)
    },
    cleanup: leaveDraft,
  },
  { name: 'review-center-list', async setup(ctx) { await openReviews(ctx) } },
  {
    name: 'review-center-drawer',
    async setup(ctx) {
      await openReviews(ctx)
      // Click the request's title; the row opens its drawer.
      const opened = await ctx.evalJs(`
        const t = [...document.querySelectorAll('main *')]
          .find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(REVIEW_TITLE)})
        t?.click()
        return !!t`)
      if (!opened) throw new Error('review not found')
      await sleep(2500)
    },
  },
  {
    // One-shot: needs a data source that is not under version control yet.
    name: 'versioning-change-control-enable',
    async setup(ctx) {
      await ctx.goto(`${APP_ORIGIN}/views/${ctx.viewId(UNVERSIONED_VIEW)}`); await sleep(5000)
      if (!await clickText(ctx.evalJs, 'Enable version control', 'main')) {
        throw new Error(`version control is already on under "${UNVERSIONED_VIEW}" — this shot needs a source without it`)
      }
      await sleep(1500)
      await clickText(ctx.evalJs, 'Turn on version control', '[role="dialog"]')
      for (let i = 0; i < 60 && !(await ctx.evalJs(`return document.body.innerText.includes('Everything checked out')`)); i++) await sleep(1000)
    },
  },
  // Administrators.
  { name: 'admin-setup-providers', route: '/ingestion?tab=providers' },
  { name: 'admin-setup-invite', route: '/admin/users', setup: openInvite },
  {
    name: 'users-access-invite-wizard',
    route: '/admin/users',
    async setup(ctx) {
      await openInvite(ctx)
      await clickText(ctx.evalJs, 'Anyone with the link', 'body', 'button'); await sleep(600)
      await clickText(ctx.evalJs, 'Next'); await sleep(1200) // What they get
      await clickText(ctx.evalJs, 'Next'); await sleep(1500) // Safety
    },
  },
  {
    name: 'workspace-admin-members',
    async setup(ctx) {
      await ctx.goto(`${APP_ORIGIN}/workspaces/${ctx.wsId}?tab=members`); await settle(ctx.evalJs)
      if (!await clickText(ctx.evalJs, 'Add member', 'main')) throw new Error('no Add member button')
      await sleep(1500)
    },
  },
  {
    name: 'feature-switches-list',
    route: '/admin/features',
    async setup(ctx) {
      await clickText(ctx.evalJs, 'Version control', 'main', 'button, [role="option"], li'); await sleep(1200)
    },
  },
  { name: 'data-freshness-freshness-tab', route: '/ingestion?tab=freshness' },
  { name: 'observability-infrastructure', route: '/admin/infrastructure' },
  {
    // Needs a graph the provider holds that no workspace uses yet (AVAILABLE).
    name: 'onboarding-a-source-assets',
    route: '/ingestion?tab=assets',
    async setup(ctx) {
      await clickText(ctx.evalJs, 'Refresh', 'main') // discover graphs added since the last sweep
      let queued = false
      for (let i = 0; i < 30 && !queued; i++) {
        await sleep(1000)
        queued = await ctx.evalJs(`
          const row = [...document.querySelectorAll('main .rounded-xl')].find((r) =>
            /\\bAVAILABLE\\b/.test(r.innerText || '') && r.querySelectorAll('[role="checkbox"]').length === 1)
          row?.querySelector('[role="checkbox"]').click()
          return !!row`)
      }
      if (!queued) throw new Error('no AVAILABLE graph to queue — every graph is already onboarded')
      await sleep(1000)
    },
  },
  {
    name: 'analytics-overview',
    route: '/analytics',
    async setup(ctx) { await clickText(ctx.evalJs, '14d', 'main'); await sleep(1500) },
  },
  { name: 'governance-ops-branding', route: '/admin/branding' },
  { name: 'graph-store-topology-overview', route: '/admin/graph-store' },
  {
    name: 'graph-store-topology-view-cache',
    route: '/admin/graph-store',
    async setup(ctx) {
      await ctx.evalJs(`
        const h = [...document.querySelectorAll('main h2, main h3, main h4')].find((e) => e.textContent.trim().startsWith('View cache'))
        h?.scrollIntoView({ block: 'start' }); return !!h`)
      await sleep(800)
    },
  },
  {
    // The canvas's "slow" state, as a slow graph store causes it: every graph read
    // is answered 504 (Gateway Timeout) — in this browser only, for this shot only.
    name: 'troubleshooting-state-card',
    async setup(ctx) {
      ctx.failGraphReads = true
      await ctx.cdp('Fetch.enable', { patterns: [{ urlPattern: '*/graph/*', requestStage: 'Request' }] })
      await setSidebar(ctx.evalJs, true)
      await ctx.goto(`${APP_ORIGIN}/views/${ctx.viewId(CONTEXT_VIEW)}`)
      for (let i = 0; i < 40 && !(await ctx.evalJs(`return document.body.innerText.includes('Taking a little longer than usual')`)); i++) await sleep(500)
    },
    async cleanup(ctx) { ctx.failGraphReads = false; await ctx.cdp('Fetch.disable') },
  },
  // What someone without access sees.
  { name: 'requesting-access-denied-panel', as: 'viewer', route: '/admin/users' },
  {
    name: 'requesting-access-denied-card',
    as: 'viewer',
    async setup(ctx) {
      // Opening the workspace's own page asks for its members — refused for a viewer.
      await ctx.goto(`${APP_ORIGIN}/workspaces/${ctx.wsId}?tab=members`)
      for (let i = 0; i < 20 && !(await ctx.evalJs(`return document.body.innerText.includes('Request access')`)); i++) await sleep(500)
    },
  },
]

/** Sign in as the workspace viewer from .env.dev, the way `login()` signs in the admin. */
async function loginViewer(evalJs, goto) {
  const env = readFileSync(fileURLToPath(new URL('../../.env.dev', import.meta.url)), 'utf8')
  const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
  if (!pick('VIEWER_EMAIL')) throw new Error('VIEWER_EMAIL / VIEWER_PASSWORD are not in .env.dev')
  await goto(`${APP_ORIGIN}/login`)
  const status = await evalJs(`
    const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(pick('VIEWER_EMAIL'))}, password: ${JSON.stringify(pick('VIEWER_PASSWORD'))} }) })
    return r.status`)
  if (status !== 200) throw new Error(`viewer sign-in failed: HTTP ${status}`)
}

const conn = await connect()
const { cdp, on, evalJs, goto, shot, waitForCanvas } = conn
const failures = []
// A cleanup step answers the app's own "Discard all … ?" confirm. Left open, a
// native dialog blocks the page and every later shot times out.
on('Page.javascriptDialogOpening', () => cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}))
// troubleshooting-state-card: while set, graph reads are answered 504.
const GATEWAY_TIMEOUT = Buffer.from(JSON.stringify({ detail: 'Gateway Timeout' })).toString('base64')
on('Fetch.requestPaused', (p) => (ctx.failGraphReads
  ? cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 504, body: GATEWAY_TIMEOUT,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] })
  : cdp('Fetch.continueRequest', { requestId: p.requestId })).catch(() => {}))
let ctx = {}
try {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await login(evalJs, goto)
  // Light theme, and no first-visit callouts: they belong to a person's first
  // look at a screen, not to the guide's picture of it.
  await evalJs(`
    const p = JSON.parse(localStorage.getItem('nexus-preferences') ?? '{"state":{}}')
    p.state.theme = 'light'
    localStorage.setItem('nexus-preferences', JSON.stringify(p))
    localStorage.setItem('synodic.propertyManager.seen.v1', '1')
    return true`)

  const views = await listViews(evalJs, goto)
  const viewId = (name) => views.find((v) => v.name === name)?.id ?? (() => { throw new Error(`no view "${name}"`) })()
  const wsId = await evalJs(`
    const r = await fetch('/api/v1/admin/workspaces', { credentials: 'include' })
    return (await r.json()).find((w) => w.name === ${JSON.stringify(WORKSPACE)})?.id`)
  ctx = { cdp, evalJs, goto, waitForCanvas, h: helpers(evalJs), viewId, wsId }
  let as = 'admin'

  mkdirSync(OUT, { recursive: true })
  for (const s of SHOTS.filter((x) => !only.length || only.includes(x.name))) {
    try {
      if ((s.as ?? 'admin') !== as) {
        as = s.as ?? 'admin'
        await (as === 'viewer' ? loginViewer(evalJs, goto) : login(evalJs, goto))
      }
      await setSidebar(evalJs, false) // canvas shots collapse it in openCanvas()
      if (s.route) await goto(`${APP_ORIGIN}${s.route}`)
      await settle(evalJs)
      await s.setup?.(ctx)
      if (!s.instant) await settle(evalJs)
      // Toasts are about what the script just did, not about the screen.
      await evalJs(`document.querySelector('[data-testid="notification-stack"]')?.style.setProperty('display', 'none'); return true`)
      await shot(join(OUT, `${s.name}.png`))
      console.log(`  ✓ ${s.name}.png`)
    } catch (err) {
      failures.push(s.name)
      console.log(`  ✗ ${s.name}.png — ${err.message}`)
    } finally {
      await s.cleanup?.(ctx).catch(() => {})
    }
  }
} finally {
  conn.close()
}
console.log(`${failures.length ? `${failures.length} failed` : 'All shots taken'} → ${OUT}`)
// app-probe's per-call timers would otherwise hold the process open for 45 s.
process.exit(failures.length ? 1 : 0)
