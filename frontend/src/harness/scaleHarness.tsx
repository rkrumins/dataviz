/**
 * Scale harness — the change review surfaces at volume, in the real browser, with their real
 * components and stores and a stubbed server:
 *
 *   review     Review & Save on `n` staged changes (default 50,000)
 *   map        the same, on the Map (clustered past 200 entities)
 *   changes    a draft's change list of `n` changes (default 100,000), one row opened
 *   tree       the same list top-down: a warehouse, 5 schemas, 200 tables each, 100 changed columns
 *              each — a level opened, a page more, a search across all of it, a result revealed
 *   review-tree  Review & Save top-down: the 50,000 staged changes under the canvas's 3,000
 *              entities (10 databases › 100 schemas › tables), the rest "Elsewhere in the graph"
 *   navigator  the canvas change navigator, 10,482 stops (`&missing=1`: one not in this view)
 *
 *   npm run harness
 *   open http://localhost:5199/scale-harness.html?fixture=review&theme=dark
 *
 * `npm run harness:scale` drives each fixture through Chromium, times it against its budget
 * (`window.__scale`, below) and writes PNGs to .harness/.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { StagedChangesPanel } from '../components/canvas/context-view/StagedChangesPanel'
import { ChangeNavigator } from '../components/canvas/context-view/ChangeNavigator'
import { ChangeList } from '../features/versioning/components/ChangeList'
import { useStagedChangesStore, type StagedChange } from '../store/stagedChangesStore'
import { useChangeNavigatorStore, type NavStop } from '../store/changeNavigatorStore'
import { useCanvasStore } from '../store/canvas'
import { useBranchStore } from '../store/branchStore'
import { usePreferencesStore } from '../store/preferences'
import { usePersonaStore } from '../store/persona'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'review'
const dark = params.get('theme') === 'dark'
const N = Number(params.get('n') ?? (fixture === 'changes' || fixture === 'tree' ? 100_000 : 50_000))
MotionGlobalConfig.skipAnimations = true
usePersonaStore.setState({ mode: 'business' })
usePreferencesStore.setState({ changeListLayout: fixture === 'tree' || fixture === 'review-tree' ? 'tree' : 'list' })

/** What the driver reads: the timings, and the long tasks (ms) each step caused. */
interface ScaleReport { openMs?: number; steps: Record<string, number[]>; done: boolean; error?: string }
const report: ScaleReport = { steps: {}, done: false }
;(window as unknown as { __scale: ScaleReport }).__scale = report
/** Every long task since the page started, by when it started — its report arrives later. */
const longTasks: { start: number; ms: number }[] = []
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, ms: Math.round(e.duration) }) })
    .observe({ type: 'longtask', buffered: true })
} catch { /* no long-task timing in this browser */ }

const TYPES = ['Table', 'Column', 'Dataset', 'Dashboard', 'Pipeline']
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = window.fetch
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!url.includes('/api/')) return realFetch(input, init)
  const third = Math.floor(N / 3)
  if (url.includes('/diff/summary')) {
    return json({
      origin: { branchId: 'br1' }, counts: { added: third, modified: third, removed: N - 2 * third },
      entityCounts: { added: third, modified: third, removed: N - 2 * third }, edgeCounts: { added: 0, modified: 0, removed: 0 },
      structureCounts: { added: 0, modified: 0, removed: 0 }, impact: Object.fromEntries(TYPES.map((t) => [t, Math.floor(N / 5)])),
      byType: TYPES.map((t) => ({ kind: 'node', type: t, added: Math.floor(third / 5), modified: Math.floor(third / 5), removed: Math.floor((N - 2 * third) / 5) })),
      total: N, listed: N, approximate: false, tooLarge: null, window: null,
    })
  }
  if (/\/diff\/entries\//.test(url)) {
    const id = decodeURIComponent(url.split('/diff/entries/')[1].split('?')[0])
    return json({
      entityId: id, kind: 'node', status: 'modified',
      before: { displayName: `orders_${id}`, description: 'Daily orders', version: 'a1', properties: { owner: 'ana', tier: 'silver', 'Technical/Physical/format': 'csv', retention: 30, pii: false } },
      after: { displayName: `Orders ${id}`, description: 'Daily customer orders, deduplicated', version: 'a2', properties: { owner: 'bo', tier: 'gold', 'Technical/Physical/format': 'parquet', retention: 90, pii: true, steward: 'finance' } },
    })
  }
  if (url.includes('/diff/tree')) return json(treeResponse(new URL(url, location.origin)))
  if (url.includes('/diff/entries') && fixture === 'tree') {
    // A search across the whole tree: what matches, each with where it sits.
    const u = new URL(url, location.origin)
    const q = (u.searchParams.get('q') ?? '').trim()
    const entries = q ? Array.from({ length: 40 }, (_, k) => {
      const s = k % 5, t = (k * 7) % 200, c = 7
      return { ...columnRow(s, t, c), path: ['warehouse', `schema_${s}`, `table_${s}_${t}`] }
    }) : []
    return json({ entries, total: q ? 40 : 0, offset: 0, limit: 100, hasMore: false })
  }
  if (url.includes('/diff/entries')) {
    const u = new URL(url, location.origin)
    const offset = Number(u.searchParams.get('offset') ?? 0)
    const limit = Number(u.searchParams.get('limit') ?? 100)
    const entries = Array.from({ length: Math.max(0, Math.min(limit, N - offset)) }, (_, k) => {
      const i = offset + k
      const status = (['added', 'modified', 'removed'] as const)[i % 3]
      // What each row changed, as the server summarizes it (`summary=true`).
      const fields = u.searchParams.get('summary') !== 'true' ? undefined : status === 'modified'
        ? { changed: 3, added: 1, removed: 1, total: 5 + (i % 7), top: [
            { label: 'Description', kind: 'changed', before: 'Daily orders', after: 'Daily customer orders, deduplicated' },
            { label: 'owner', kind: 'changed', before: 'ana', after: 'bo' },
            { label: 'tier', kind: 'changed', before: 'silver', after: 'gold' },
            { label: 'steward', kind: 'added', before: null, after: 'finance' },
            { label: 'legacy_id', kind: 'removed', before: 'L-17', after: null }] }
        : { changed: 0, added: status === 'added' ? 6 : 0, removed: status === 'removed' ? 6 : 0, total: 6, top: [
            { label: 'Name', kind: status === 'added' ? 'added' : 'removed', before: status === 'added' ? null : `entity_${i}`, after: status === 'added' ? `entity_${i}` : null },
            { label: 'Type', kind: status === 'added' ? 'added' : 'removed', before: status === 'added' ? null : 'Table', after: status === 'added' ? 'Table' : null },
            { label: 'owner', kind: status === 'added' ? 'added' : 'removed', before: status === 'added' ? null : 'ana', after: status === 'added' ? 'ana' : null }] }
      return { entityId: `e${i}`, kind: 'node', status, type: TYPES[Math.floor(i / 2000) % 5], structural: false, displayName: `entity_${i}`, urn: `urn:e${i}`, qualifiedName: `warehouse.sales.entity_${i}`, fields }
    })
    return json({ entries, total: N, offset, limit, hasMore: offset + entries.length < N })
  }
  return json({ detail: 'not in harness' }, 404)
}) as typeof window.fetch

/** `n` staged changes: edits, creates, deletes (some refused), new relationships — over 3,000
 *  entities on the canvas. */
function seedStaged() {
  // Top-down, the canvas's entities sit in a hierarchy: 10 databases › 100 schemas › the tables.
  const parentOf = (i: number) => (fixture !== 'review-tree' || i < 10 ? undefined : i < 110 ? `urn:n${i % 10}` : `urn:n${10 + (i % 100)}`)
  const nodes = Array.from({ length: 3000 }, (_, i) => ({
    id: `urn:n${i}`, type: 'generic', position: { x: 0, y: 0 },
    data: { urn: `urn:n${i}`, label: `customer_orders_${i}`, type: TYPES[i % 5], parentId: parentOf(i) },
  }))
  useCanvasStore.setState({ nodes, _nodeIndex: new Set(nodes.map((n) => n.id)) } as never)
  const changes: StagedChange[] = []
  for (let i = 0; i < N; i++) {
    const urn = `urn:n${i}`
    const label = `customer_orders_${i}`
    const r = i % 25
    if (r < 18) {
      changes.push({ id: `c${i}`, type: 'update_entity', targetId: urn, targetUrn: urn, timestamp: i, summary: `Edit 3 fields on '${label}'`,
        before: { label, type: TYPES[i % 5], description: 'Orders', properties: { owner: 'ana', tier: 'silver' } },
        after: { label, type: TYPES[i % 5], description: 'Customer orders', properties: { owner: i % 2 ? 'bo' : 'cy', tier: 'gold' } } })
    } else if (r < 21) {
      changes.push({ id: `c${i}`, type: 'create_entity', targetId: `urn:staged:${i}`, targetUrn: `urn:staged:${i}`, timestamp: i,
        summary: `Create 'refunds_${i}'`, after: { displayName: `refunds_${i}`, entityType: TYPES[i % 5], parentUrn: `urn:n${i % 3000}` } })
    } else if (r < 23) {
      changes.push({ id: `c${i}`, type: 'delete_entity', targetId: urn, targetUrn: urn, timestamp: i, summary: `Delete '${label}'`,
        before: { node: { id: urn, data: { label } } }, after: null, ...(i % 50 === 21 ? { error: 'A Column must sit inside a Table.' } : {}) })
    } else {
      changes.push({ id: `c${i}`, type: 'create_edge', targetId: `edge${i}`, timestamp: i, summary: 'Create FEEDS edge',
        after: { source: `urn:n${(i * 13) % 3000}`, target: `urn:n${(i * 7 + 3) % 3000}`, edgeType: 'FEEDS' } })
    }
  }
  useStagedChangesStore.setState({ changes, past: [], redoStack: [], applyStatus: 'idle' } as never)
  useBranchStore.setState({ currentBranchId: 'br1', activeChangeSet: null } as never)
  // Opened once making the fixture has settled (its garbage collected): what is timed is the
  // review, not the harness building 50,000 changes in one go.
  setTimeout(() => {
    const opened = performance.now()
    useStagedChangesStore.getState().openReviewPanel()
    void until(() => document.querySelector('[role=list][aria-label^="Staged changes"] [role=listitem]')).then(() => { report.openMs = Math.round(performance.now() - opened) })
  }, 1500)
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
async function until<T>(get: () => T | null | undefined, ms = 30_000): Promise<T> {
  const end = performance.now() + ms
  for (;;) {
    const v = get()
    if (v) return v
    if (performance.now() > end) throw new Error('timed out waiting')
    await frame()
  }
}
/** The long tasks a step caused: those that started while it ran. */
async function step(name: string, act: () => void | Promise<void>) {
  const start = performance.now()
  await act()
  await frame(); await frame()
  const end = performance.now()
  await new Promise((r) => setTimeout(r, 50))     // let the reports of its tasks arrive
  report.steps[name] = longTasks.filter((t) => t.start >= start && t.start < end).map((t) => t.ms)
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
// The tree fixture: warehouse › 5 schemas › 200 tables each › 100 changed columns each (100,000).
const SCHEMAS = 5, TABLES = 200, COLUMNS = 100
const columnRow = (s: number, t: number, c: number) => ({
  entityId: `c_${s}_${t}_${c}`, kind: 'node', status: (['modified', 'added', 'removed'] as const)[c % 3], type: 'Column',
  structural: false, displayName: `col_${c}`, urn: `urn:c_${s}_${t}_${c}`,
  fields: { changed: 2, added: 0, removed: 0, total: 2, top: [
    { label: 'Description', kind: 'changed', before: 'Order total', after: 'Order total, in cents' },
    { label: 'owner', kind: 'changed', before: 'ana', after: 'bo' }] },
})
const inside = (n: number) => ({ added: Math.floor(n / 3), modified: n - 2 * Math.floor(n / 3), removed: Math.floor(n / 3) })
function treeResponse(u: URL) {
  if (u.pathname.endsWith('/path')) {
    const [, s, t, c] = (u.searchParams.get('entityId') ?? 'c_0_0_0').split('_').map(Number)
    return { entityId: u.searchParams.get('entityId'), at: c, path: [
      { id: 'db', name: 'warehouse', at: 0 }, { id: `s_${s}`, name: `schema_${s}`, at: s }, { id: `t_${s}_${t}`, name: `table_${s}_${t}`, at: t }] }
  }
  const parent = u.searchParams.get('parent')
  const offset = Number(u.searchParams.get('offset') ?? 0)
  const limit = Number(u.searchParams.get('limit') ?? 100)
  const [kind, a, b] = (parent ?? 'top').split('_')
  let all: number, item: (i: number) => unknown
  if (!parent) {
    all = 1
    item = () => ({ id: 'db', name: 'warehouse', type: 'Database', hasChildren: true, inside: inside(SCHEMAS * TABLES * COLUMNS) })
  } else if (kind === 'db') {
    all = SCHEMAS
    item = (i) => ({ id: `s_${i}`, name: `schema_${i}`, type: 'Schema', hasChildren: true, inside: inside(TABLES * COLUMNS) })
  } else if (kind === 's') {
    all = TABLES
    item = (i) => ({ id: `t_${a}_${i}`, name: `table_${a}_${i}`, type: 'Table', hasChildren: true, inside: inside(COLUMNS) })
  } else {
    all = COLUMNS
    item = (i) => ({ id: `c_${a}_${b}_${i}`, hasChildren: false, inside: { added: 0, modified: 0, removed: 0 }, change: columnRow(Number(a), Number(b), i) })
  }
  const items = Array.from({ length: Math.max(0, Math.min(limit, all - offset)) }, (_, k) => item(offset + k))
  return { items, total: all, offset, limit, hasMore: offset + items.length < all, path: [] }
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** What the driver times, per fixture. */
async function drive() {
  try {
    if (fixture === 'review' || fixture === 'map') {
      const list = await until(() => document.querySelector<HTMLElement>('[role=list][aria-label="Staged changes"]'))
      const scroller = list.parentElement as HTMLElement
      await until(() => report.openMs)
      if (fixture === 'review') {
        await step('settle', () => new Promise((r) => setTimeout(r, 600)))
        await step('first-j', () => { key(list, 'j') })
        await step('step60', async () => { for (let i = 0; i < 60; i++) { key(list, 'j'); await frame() } })
        await step('end', () => { key(list, 'End') })
        await step('scroll', async () => { scroller.scrollTop = scroller.scrollHeight / 2; await frame(); scroller.scrollTop = scroller.scrollHeight / 4 })
        await step('home', async () => { key(list, 'Home'); await frame() })
        await step('open', async () => { key(list, 'ArrowRight'); await until(() => list.querySelector('[role=region]')) })
        await step('open-all', async () => { key(list, 'ArrowRight'); await frame() })
        await step('expand-all', async () => {
          ;[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Expand all')?.click()
          await until(() => list.querySelectorAll('[role=region]').length > 4)
        })
        await step('scroll-expanded', async () => {
          for (let k = 1; k <= 8; k++) { scroller.scrollTop += 1500; await new Promise((r) => setTimeout(r, 60)) }
        })
        await step('filter', async () => {
          type(document.querySelector<HTMLInputElement>('input[placeholder^="Search by name"]')!, 'customer_orders_49')
          await new Promise((r) => setTimeout(r, 400))
        })
      } else {
        await step('map', async () => {
          ;[...document.querySelectorAll<HTMLElement>('[role=radio]')].find((b) => /Map/.test(b.textContent ?? ''))?.click()
          await until(() => document.querySelector('.react-flow__node'))
        })
      }
    }
    if (fixture === 'changes') {
      const opened = performance.now()
      await until(() => [...document.querySelectorAll('[role=listitem]')].find((r) => /entity_1\b/.test(r.textContent ?? '')))
      report.openMs = Math.round(performance.now() - opened)
      await step('open-row', async () => {
        ;[...document.querySelectorAll<HTMLButtonElement>('[role=listitem] button')].find((b) => /entity_1\b/.test(b.textContent ?? ''))?.click()
        await until(() => [...document.querySelectorAll('button')].find((b) => /^Show all \d+ fields$/.test(b.textContent ?? '')))
      })
      await step('expand-all', async () => {
        ;[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Expand all')?.click()
        await until(() => document.querySelectorAll('[role=listitem] [role=region]').length > 4)
      })
      await step('scroll-expanded', async () => {
        const list = document.querySelector('[role=list][aria-label="Changes"]')?.parentElement
        for (let k = 1; k <= 8 && list; k++) {
          list.scrollTop = k * 1500
          await new Promise((r) => setTimeout(r, 60))
        }
      })
    }
    if (fixture === 'tree') {
      const opened = performance.now()
      const row = (id: string) => document.getElementById(`change-tree-${id}`) as HTMLButtonElement | null
      await until(() => row('db'))
      report.openMs = Math.round(performance.now() - opened)
      const list = document.querySelector<HTMLElement>('[role=list][aria-label="Changes, top-down"]')!
      await step('open-level', async () => { row('db')!.click(); await until(() => row('s_0')) })
      await step('step-in', async () => {
        key(list, 'j')
        await frame()
        key(list, 'ArrowRight')
        await until(() => row('t_0_0'))
        key(list, 'ArrowRight')
        await frame()
        key(list, 'ArrowRight')
        await until(() => row('c_0_0_5'))
      })
      await step('open-change', async () => { row('c_0_0_1')!.click(); await until(() => list.querySelector('[role=region]')) })
      await step('more', async () => {
        const scroller = list.parentElement!
        scroller.scrollTop = scroller.scrollHeight
        const more = await until(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Show 100 more/.test(b.textContent ?? '')))
        more.click()
        // The page arrives, then the list grows under where it was scrolled: follow it to the end.
        await until(() => { scroller.scrollTop = scroller.scrollHeight; return document.querySelector('[id^="change-tree-t_0_19"]') })
      })
      await step('search', async () => {
        type(document.querySelector<HTMLInputElement>('input[placeholder^="Search every change"]')!, 'col_7')
        await until(() => [...document.querySelectorAll('[role=list][aria-label="Changes"] [role=listitem]')].length >= 5)
      })
      await step('reveal', async () => {
        ;[...document.querySelectorAll<HTMLButtonElement>('button[aria-label$="in the hierarchy"]')][3]?.click()
        await until(() => row('c_3_21_7')?.getAttribute('tabindex') === '0')
      })
    }
    if (fixture === 'review-tree') {
      await until(() => report.openMs)
      const list = await until(() => document.querySelector<HTMLElement>('[role=list][aria-label="Staged changes, top-down"]'))
      const row = (id: string) => document.getElementById(`change-tree-${id}`) as HTMLButtonElement | null
      await step('settle', () => new Promise((r) => setTimeout(r, 600)))
      // These databases and schemas are edited themselves: their chevron opens what is inside.
      const inside = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Show what's inside ${name}"]`)
      await step('open-level', async () => { inside('customer_orders_0')!.click(); await until(() => row('urn:n10')) })
      await step('step-in', async () => {
        // Scrolled to, as a person would: only the rows in view are drawn.
        const scroller = list.parentElement!
        scroller.scrollTop = 0
        const target = await until(() => inside('customer_orders_10') ?? void (scroller.scrollTop += 240))
        target.click()
        await until(() => list.querySelector('[role=listitem][aria-level="3"]') ?? void (scroller.scrollTop += 120))
      })
      await step('elsewhere', async () => {
        const scroller = list.parentElement!
        await until(() => { scroller.scrollTop = scroller.scrollHeight; return row('~elsewhere') })
        row('~elsewhere')!.click()
        await until(() => { scroller.scrollTop = scroller.scrollHeight; return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Show 100 more/.test(b.textContent ?? '')) })
      })
      await step('more', async () => {
        ;[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Show 100 more/.test(b.textContent ?? ''))!.click()
        await frame()
      })
      await step('filter', async () => {
        type(document.querySelector<HTMLInputElement>('input[placeholder^="Search by name"]')!, 'customer_orders_2050')
        await until(() => document.querySelector('[role=list][aria-label="Staged changes"] [role=listitem]'))
      })
      await step('reveal', async () => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Show customer_orders_2050 in the hierarchy"]')!.click()
        await until(() => row('urn:n2050')?.getAttribute('tabindex') === '0')
      })
    }
    if (fixture === 'navigator') await until(() => document.querySelector('[aria-label="Change navigator"]'))
  } catch (e) {
    report.error = String(e)
  } finally {
    await new Promise((r) => setTimeout(r, 300))
    report.done = true
  }
}

function Harness() {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
    document.body.style.background = 'var(--nx-bg)'
  }, [setTheme])
  useEffect(() => {
    if (fixture === 'review' || fixture === 'map' || fixture === 'review-tree') seedStaged()
    if (fixture === 'navigator') {
      const stops: NavStop[] = Array.from({ length: 10_482 }, (_, i) => ({ id: `urn:${i}`, name: i === 11 ? 'Customer Orders' : `entity_${i}`, status: i % 4 ? 'modified' : 'added', saved: i > 5000 }))
      useStagedChangesStore.setState({ changes: [{ id: 'x', type: 'rename_entity', targetId: 'urn:0', after: {}, summary: '', timestamp: 0 }] } as never)
      useChangeNavigatorStore.getState().start(stops, { scope: 'unsaved', atId: params.get('missing') ? 'urn:12' : 'urn:11' })
    }
    void drive()
  }, [])
  if (fixture === 'changes' || fixture === 'tree') {
    return (
      <div className="min-h-screen bg-canvas p-8">
        <div className="max-w-[720px] mx-auto rounded-2xl border border-glass-border bg-canvas-elevated p-5">
          <h2 className="text-sm font-bold text-ink mb-3">Changes in this draft</h2>
          <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br1' }} maxHeight={640} />
        </div>
      </div>
    )
  }
  if (fixture === 'navigator') {
    return (
      <div className="min-h-screen bg-canvas" style={{ backgroundImage: 'radial-gradient(var(--nx-border) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        <ChangeNavigator reveal={async (id) => (id === 'urn:12' ? 'unavailable' : 'revealed')} />
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-canvas">
      <StagedChangesPanel onConfirm={() => true} wsId="ws1" graphId="g1" dataSourceId="ds1" viewId="v1" onReveal={() => {}} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Harness /></MemoryRouter>
  </QueryClientProvider>,
)
