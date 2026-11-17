/**
 * Scale harness — the change review surfaces at volume, in the real browser, with their real
 * components and stores and a stubbed server:
 *
 *   review     Review & Save on `n` staged changes (default 50,000)
 *   map        the same, on the Map (clustered past 200 entities)
 *   changes    a draft's change list of `n` changes (default 100,000), one row opened
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
const N = Number(params.get('n') ?? (fixture === 'changes' ? 100_000 : 50_000))
MotionGlobalConfig.skipAnimations = true
usePersonaStore.setState({ mode: 'business' })

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
  const nodes = Array.from({ length: 3000 }, (_, i) => ({
    id: `urn:n${i}`, type: 'generic', position: { x: 0, y: 0 },
    data: { urn: `urn:n${i}`, label: `customer_orders_${i}`, type: TYPES[i % 5] },
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
    void until(() => document.querySelector('[role=listbox] [role=option]')).then(() => { report.openMs = Math.round(performance.now() - opened) })
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
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** What the driver times, per fixture. */
async function drive() {
  try {
    if (fixture === 'review' || fixture === 'map') {
      const list = await until(() => document.querySelector<HTMLElement>('[role=listbox][aria-label="Staged changes"]'))
      await until(() => report.openMs)
      if (fixture === 'review') {
        await step('settle', () => new Promise((r) => setTimeout(r, 600)))
        await step('first-j', () => { key(list, 'j') })
        await step('step60', async () => { for (let i = 0; i < 60; i++) { key(list, 'j'); await frame() } })
        await step('end', () => { key(list, 'End') })
        await step('scroll', async () => { list.scrollTop = list.scrollHeight / 2; await frame(); list.scrollTop = list.scrollHeight / 4 })
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
    if (fixture === 'review' || fixture === 'map') seedStaged()
    if (fixture === 'navigator') {
      const stops: NavStop[] = Array.from({ length: 10_482 }, (_, i) => ({ id: `urn:${i}`, name: i === 11 ? 'Customer Orders' : `entity_${i}`, status: i % 4 ? 'modified' : 'added', saved: i > 5000 }))
      useStagedChangesStore.setState({ changes: [{ id: 'x', type: 'rename_entity', targetId: 'urn:0', after: {}, summary: '', timestamp: 0 }] } as never)
      useChangeNavigatorStore.getState().start(stops, { scope: 'unsaved', atId: params.get('missing') ? 'urn:12' : 'urn:11' })
    }
    void drive()
  }, [])
  if (fixture === 'changes') {
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
