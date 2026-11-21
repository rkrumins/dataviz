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
 * Bulk editing, in a draft:
 *
 *   multi-entity  the entity drawer on 10,000 entities × 50 properties (Same, Differs, Partial):
 *              Differs, a name typed in "Find a property", a row opened, a value applied to all, staged
 *   cleanup-merge  the bulk dialog's Merge values on a property with 1,000 values in ~300
 *              near-duplicate groups: the groups scrolled, some turned off, a kept value changed
 *   multi-relationship  the relationship drawer on 1,000 relationships, read in one request:
 *              filtered, a row opened, a value applied to all, staged
 *   jobs-panel  Property Manager's jobs: 20 ended, 40 running whose progress moves every 100 ms
 *              for 10 s — and the draft's data key, which moves at most once per 30 s meanwhile
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
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { useSchemaStore } from '../store/schema'
import { useDraftPropertyJobs, usePropertyJobsStore, type TrackedJob } from '../store/propertyJobsStore'
import { EntityDrawer } from '../components/panels/entity/EntityDrawer'
import { RelationshipDrawer } from '../components/panels/RelationshipDrawer'
import { PropertyOpHost } from '../components/canvas/property-manager/PropertyOpHost'
import { PropertyJobsPanel } from '../components/canvas/property-manager/PropertyJobsPanel'
import { NotificationStack } from '../components/ui/notifications'
import { useDraftDataKey } from '../features/versioning/hooks/useDraftDataKey'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { RemoteGraphProvider } from '../providers/RemoteGraphProvider'
import { targetFromMembers } from '../lib/drawerEdgeTarget'
import type { PropertyJob, PropertyJobOp } from '../services/versioningApiService'
import type { SearchCatalogValue } from '../types/search'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'review'
const dark = params.get('theme') === 'dark'
const N = Number(params.get('n') ?? (fixture === 'changes' || fixture === 'tree' ? 100_000 : 50_000))
MotionGlobalConfig.skipAnimations = true
usePersonaStore.setState({ mode: 'business' })
usePreferencesStore.setState({ changeListLayout: fixture === 'tree' || fixture === 'review-tree' ? 'tree' : 'list' })

/** What the driver reads: the timings, the long tasks (ms) each step caused, and what a fixture
 *  counted besides (`checks`). */
interface ScaleReport { openMs?: number; steps: Record<string, number[]>; checks?: Record<string, number>; done: boolean; error?: string }
const report: ScaleReport = { steps: {}, done: false }
;(window as unknown as { __scale: ScaleReport }).__scale = report
/** Every long task since the page started, by when it started — its report arrives later. */
const longTasks: { start: number; ms: number }[] = []
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, ms: Math.round(e.duration) }) })
    .observe({ type: 'longtask', buffered: true })
} catch { /* no long-task timing in this browser */ }

const TYPES = ['Table', 'Column', 'Dataset', 'Dashboard', 'Pipeline']
/** The bulk-editing fixtures — each in a draft (`br1` of graph `g1`) of the view `v1`, so each
 *  offers its edits as the app does there. */
const BULK = ['multi-entity', 'cleanup-merge', 'multi-relationship', 'jobs-panel'].includes(fixture)
if (BULK) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, editModeEnabled: true } } as never)
  useSchemaStore.setState({
    activeViewId: 'v1',
    schema: {
      id: 'ws1', name: 'Harness', version: '1', relationshipTypes: [], defaultViewId: 'v1',
      containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['FEEDS'],
      entityTypes: TYPES.map((t) => ({
        id: t, name: t, pluralName: `${t}s`, fields: [], hierarchy: {}, behavior: {},
        visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
      })),
      views: [{ id: 'v1', name: 'Sales lineage', workspaceId: 'ws1', dataSourceId: 'ds1', content: {}, filters: {}, entityOverrides: {}, isDefault: true, isPublic: false, createdBy: 'harness' }],
    },
  } as never)
  useBranchStore.setState({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1', graphId: 'g1', mainBranchId: 'main', currentBranchId: 'br1' } as never)
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = window.fetch
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!url.includes('/api/')) return realFetch(input, init)
  const third = Math.floor(N / 3)
  if (BULK && url.includes('/versioning/resolve')) return json({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 1 })
  if (BULK && url.includes('/graphs/g1/edges/read')) return json(edgesRead(JSON.parse(String(init?.body)).refs))
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
  // Acted on in a task of its own: a long task is timed from when its task began, so an action
  // done in the task that read `start` (a click, a key) would count from before it — and be missed.
  await new Promise((r) => setTimeout(r, 0))
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

// ── Bulk editing ──────────────────────────────────────────────────────────────
const date = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10)
/** `pct` in every hundred of the entities, spread through them. */
const some = (i: number, pct: number) => (i * 37) % 100 < pct
const OWNERS = ['ana', 'bo', 'cy', 'dee', 'eli', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kai', 'lu']
const DOTS = { backgroundImage: 'radial-gradient(var(--nx-border) 1px, transparent 1px)', backgroundSize: '18px 18px' }
const GRAPH_WRITE = { wsId: 'ws1', graphId: 'g1', branchId: 'br1' }

/** Open a fixture once making it has settled, and time it until `shown`. */
function openTimed(open: () => void, shown: () => unknown) {
  setTimeout(() => {
    const opened = performance.now()
    open()
    void until(shown).then(() => { report.openMs = Math.round(performance.now() - opened) })
  }, 1500)
}
const propertiesOf = (i: number, props: ReadonlyArray<[string, (i: number) => unknown]>) => {
  const out: Record<string, unknown> = {}
  for (const [k, value] of props) {
    const v = value(i)
    if (v !== undefined) out[k] = v
  }
  return out
}

const ENTITIES = 10_000
/** The 50 properties of the multi-entity fixture: 15 alike on all, 20 held by all but not alike
 *  (from 2 values to one per entity), 15 held by only some. */
const ENTITY_PROPS: Array<[string, (i: number) => unknown]> = [
  ['domain', () => 'Sales'], ['platform', () => 'Snowflake'], ['region', () => 'eu-west-1'], ['retention_days', () => 365],
  ['pii', () => false], ['format', () => 'parquet'], ['encrypted', () => true], ['lifecycle', () => 'active'],
  ['source_system', () => 'SAP'], ['cost_center', () => 'CC-1042'], ['classification', () => 'internal'], ['refresh', () => 'daily'],
  ['compliance', () => ['GDPR', 'SOX']], ['catalogued', () => true], ['schema_version', () => 3],
  ['owner', (i) => OWNERS[i % OWNERS.length]], ['steward', (i) => `steward_${i % 40}`], ['tier', (i) => ['gold', 'silver', 'bronze'][i % 3]],
  ['sla', (i) => ['1h', '4h', '12h', '24h'][i % 4]], ['row_count', (i) => 1000 + i * 17], ['last_audit', (i) => date(i % 365)],
  ['quality_score', (i) => i % 100], ['team', (i) => `team_${i % 25}`], ['business_unit', (i) => `bu_${i % 8}`],
  ['freshness_minutes', (i) => (i * 7) % 1440], ['criticality', (i) => ['low', 'medium', 'high'][i % 3]], ['storage_gb', (i) => (i * 13) % 1000],
  ['partition_key', (i) => ['date', 'region', 'customer_id', 'none', 'hour', 'country'][i % 6]], ['database', (i) => `db_${i % 10}`],
  ['schema', (i) => `schema_${i % 50}`], ['labels', (i) => [`l${i % 6}`, `l${6 + (i % 5)}`]],
  ['description_status', (i) => ['missing', 'draft', 'reviewed'][i % 3]], ['certified', (i) => i % 2 === 0],
  ['upstream_count', (i) => i % 20], ['lineage_depth', (i) => i % 8],
  ['deprecated_on', (i) => (some(i, 5) ? date(i % 90) : undefined)], ['jira', (i) => (some(i, 10) ? `DATA-${i}` : undefined)],
  ['notes', (i) => (some(i, 30) ? 'Backfilled after the 2025 migration' : undefined)],
  ['contract', (i) => (some(i, 50) ? ['v1', 'v2', 'v3'][i % 3] : undefined)], ['sensitivity', (i) => (some(i, 70) ? 'confidential' : undefined)],
  ['review_by', (i) => (some(i, 40) ? date(180 + (i % 30)) : undefined)], ['legacy_id', (i) => (some(i, 25) ? `L-${i}` : undefined)],
  ['external_url', (i) => (some(i, 15) ? `https://wiki.example.com/data/${i}` : undefined)],
  ['sample_rate', (i) => (some(i, 60) ? [0.1, 0.5, 1][i % 3] : undefined)], ['backup', (i) => (some(i, 80) ? ['nightly', 'weekly'][i % 2] : undefined)],
  ['dq_rule', (i) => (some(i, 35) ? `not_null(${['id', 'ts', 'amount'][i % 3]})` : undefined)], ['consumers', (i) => (some(i, 45) ? i % 12 : undefined)],
  ['slack_channel', (i) => (some(i, 20) ? `#data-${i % 9}` : undefined)], ['runbook', (i) => (some(i, 12) ? `RB-${i % 40}` : undefined)],
  ['oncall', (i) => (some(i, 55) ? OWNERS[(i * 5) % OWNERS.length] : undefined)],
]
function seedEntities() {
  const nodes = Array.from({ length: ENTITIES }, (_, i) => ({
    id: `urn:e${i}`, type: 'generic', position: { x: 0, y: 0 },
    data: { urn: `urn:e${i}`, label: `orders_${i}`, type: TYPES[i % 5], version: 'v1', description: 'Daily customer orders', properties: propertiesOf(i, ENTITY_PROPS) },
  }))
  useCanvasStore.setState({ nodes, _nodeIndex: new Set(nodes.map((n) => n.id)) } as never)
  openTimed(() => useCanvasStore.getState().openNodesDrawer(nodes.map((n) => n.id)), () => document.querySelector('[data-row-key]'))
}

const RELATIONSHIPS = 1000
const ENDS = 300
/** The 20 properties each relationship holds: 6 alike, 8 not alike, 6 on only some. */
const EDGE_PROPS: Array<[string, (i: number) => unknown]> = [
  ['transport', () => 'batch'], ['verified', () => true], ['format', () => 'parquet'], ['pipeline_owner', () => 'data-eng'],
  ['encrypted', () => true], ['contract_version', () => 2],
  ['frequency', (i) => ['hourly', 'daily', 'weekly'][i % 3]], ['latency_ms', (i) => (i * 37) % 5000], ['confidence', (i) => (50 + (i % 50)) / 100],
  ['job', (i) => `job_${i}`], ['tool', (i) => ['dbt', 'Airflow', 'Spark', 'Fivetran', 'Kafka'][i % 5]], ['sla_minutes', (i) => [15, 60, 240, 1440][i % 4]],
  ['rows_per_run', (i) => 1000 + i * 3], ['mode', (i) => ['append', 'merge', 'overwrite'][i % 3]],
  ['notes', (i) => (some(i, 30) ? 'Rebuilt nightly from the raw zone' : undefined)], ['deprecated', (i) => (some(i, 5) ? true : undefined)],
  ['jira', (i) => (some(i, 10) ? `DATA-${i}` : undefined)], ['runbook', (i) => (some(i, 20) ? `RB-${i % 40}` : undefined)],
  ['backfill_from', (i) => (some(i, 40) ? date(i % 60) : undefined)], ['alert_channel', (i) => (some(i, 60) ? `#alerts-${i % 4}` : undefined)],
]
/** `POST …/graphs/g1/edges/read`: each relationship as the draft holds it, with its token. */
function edgesRead(refs: Array<{ id: string; source: string; target: string; edgeType: string }>) {
  return {
    edges: refs.map((r) => {
      const i = Number(r.id.slice('rel'.length))
      return { id: r.id, entityId: `edge:${r.id}`, version: `v${i}`, edgeType: r.edgeType, sourceEntityId: r.source, targetEntityId: r.target, properties: propertiesOf(i, EDGE_PROPS) }
    }),
    deleted: [], missing: [],
  }
}
function seedRelationships() {
  const nodes = Array.from({ length: ENDS }, (_, i) => ({
    id: `urn:n${i}`, type: 'generic', position: { x: 0, y: 0 },
    data: { urn: `urn:n${i}`, label: `${['orders', 'customers', 'payments', 'refunds', 'sessions'][i % 5]}_${i}`, type: TYPES[i % 5] },
  }))
  useCanvasStore.setState({ nodes, _nodeIndex: new Set(nodes.map((n) => n.id)) } as never)
  const members = Array.from({ length: RELATIONSHIPS }, (_, i) => ({ id: `rel${i}`, source: `urn:n${i % ENDS}`, target: `urn:n${(i * 7 + 11) % ENDS}`, edgeType: 'FEEDS', rollup: false }))
  openTimed(() => useCanvasStore.getState().openEdgeDrawer(targetFromMembers(members)), () => document.querySelector('[data-row-key]'))
}

const rows = () => document.querySelectorAll('[data-row-key]').length
const buttonNamed = (re: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => re.test(b.textContent ?? ''))
/** What both drawers do with what they compare: narrowed to Differs, a property found by its name
 *  typed a letter at a time, its row opened, its most-held value applied to all, staged in one
 *  write — and every row shown again. */
async function compareAndStage(name: string, differing: number) {
  await until(() => report.openMs)
  await step('differs', async () => {
    ;[...document.querySelectorAll<HTMLElement>('[role=radio]')].find((r) => /^Differs/.test(r.textContent ?? ''))!.click()
    await until(() => rows() === differing)
  })
  await step('find', async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a property"]')!
    for (let n = 1; n <= name.length; n++) { type(input, name.slice(0, n)); await frame() }
    await until(() => rows() === 1)
  })
  await step('expand', async () => {
    document.querySelector<HTMLButtonElement>(`[data-row-key="${name}"] button[data-row-index]`)!.click()
    await until(() => document.querySelector(`[role=list][aria-label="Values of ${name}"]`))
  })
  await step('apply-all', async () => {
    document.querySelector<HTMLButtonElement>(`[aria-label="Values of ${name}"] button[aria-label="Apply this value to all"]`)!.click()
    await until(() => buttonNamed(/^Stage for/)?.disabled === false)
  })
  const steps = useStagedChangesStore.getState().past.length
  await step('stage', async () => {
    buttonNamed(/^Stage for/)!.click()
    await until(() => useStagedChangesStore.getState().past.length > steps)
  })
  const staged = useStagedChangesStore.getState()
  report.checks = { staged: staged.changes.length, writes: staged.past.length - steps }
  if (report.checks.writes !== 1) throw new Error(`staged in ${report.checks.writes} writes, not one`)
  // Staged, it reads Same: out of Differs — every row again, the staged one marked and in view.
  await step('show-all', async () => {
    buttonNamed(/^Show all$/)!.click()
    await until(() => rows() > 1)
    document.querySelector(`[data-row-key="${name}"]`)!.scrollIntoView({ block: 'center' })
  })
}

const ADJ = ['Core', 'Retail', 'Global', 'North', 'South', 'Cloud', 'Field', 'Partner', 'Digital', 'Central', 'Regional', 'Shared', 'Platform', 'Product', 'Growth', 'Customer', 'Risk', 'Brand', 'Supply', 'People']
const NOUN = ['Finance', 'Sales', 'Marketing', 'Data', 'Ops', 'Support', 'Legal', 'Security', 'Analytics', 'Engineering', 'Design', 'Research', 'Logistics', 'Billing', 'Payments', 'Audit', 'Treasury', 'Insights', 'Quality', 'Services']
/** The merge fixture's property: 1,000 values — 300 names each written 2–4 ways ("Core Finance",
 *  "core finance", "CORE FINANCE", "Core Finance "), and 100 written one way. Most held first. */
const TEAM_VALUES: SearchCatalogValue[] = (() => {
  const ways = [(s: string) => s, (s: string) => s.toLowerCase(), (s: string) => s.toUpperCase(), (s: string) => `${s} `]
  const out: SearchCatalogValue[] = []
  for (let g = 0; g < 400; g++) {
    const name = `${ADJ[g % 20]} ${NOUN[Math.floor(g / 20)]}`
    const written = g < 300 ? [2, 3, 4, 3][g % 4]! : 1
    for (let w = 0; w < written; w++) {
      out.push({ value: ways[w]!(name), kind: 'String', count: w === 0 ? 40 + ((g * 37) % 400) : 1 + ((g * 13 + w * 7) % 30) })
    }
  }
  return out.sort((a, b) => b.count - a.count)
})()
const TEAM_HELD = TEAM_VALUES.reduce((n, v) => n + v.count, 0)
/** `POST /search/catalog`, read in full at once: `team` with the 20 values most held — or all of
 *  them, asked for by `valuesFor` (as a merge's list reads them). */
function catalogAnswer(body: { valuesFor?: string }) {
  const owners = OWNERS.map((value, i) => ({ value, kind: 'String', count: 700 + i * 10 }))
  return {
    status: 'complete', sessionId: 'catalog-1', entities: TEAM_HELD + 2_000, tags: [],
    properties: [
      { key: 'team', count: TEAM_HELD, distinct: TEAM_VALUES.length, distinctExact: true, values: body.valuesFor === 'team' ? TEAM_VALUES : TEAM_VALUES.slice(0, 20),
        byEntityType: { Table: TEAM_HELD }, kinds: { String: TEAM_HELD }, residual: 0 },
      { key: 'owner', count: 8_000, distinct: owners.length, distinctExact: true, values: owners, byEntityType: { Table: 8_000 }, kinds: { String: 8_000 }, residual: 0 },
    ],
  }
}
/** The view's provider: it answers the property catalog, the one read the bulk dialog makes of it. */
const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
Object.assign(provider, {
  fetch: async (path: string, opts?: { body?: string }) => {
    if (path === '/search/catalog') return catalogAnswer(JSON.parse(opts?.body ?? '{}'))
    throw new Error(`${path} is not in the harness`)
  },
})
/** The merge list drawn, once every value it holds has been read. */
const mergeShown = () => document.querySelector('[role=list][aria-label="Values to merge"] [role=listitem]')
  && ![...document.querySelectorAll('[role=dialog] p')].some((p) => p.textContent?.includes('Reading every value it holds'))

const JOBS = 60
const JOB_OPS: PropertyJobOp[] = [
  { kind: 'set', key: 'owner', value: 'finance' }, { kind: 'fillEmpty', key: 'tier', value: 'silver' },
  { kind: 'rename', key: 'cust_id', to: 'customer_id' }, { kind: 'remove', key: 'legacy_id' },
  { kind: 'mapValues', key: 'team', map: [{ from: 'core finance', to: 'Core Finance' }, { from: 'CORE FINANCE', to: 'Core Finance' }] },
  { kind: 'normalize', key: 'region', trim: true, case: 'lower' }, { kind: 'convert', key: 'row_count', toKind: 'Integer' },
  { kind: 'replace', key: 'notes', find: 'Fin.', replaceWith: 'Finance' },
]
/** Of the 60 jobs, every third has ended (20); the rest run, `tick` steps of 100 ms in. */
const jobEndedAt = (j: number) => j % 3 === 0
function jobAt(j: number, tick: number): PropertyJob {
  const total = 60_000 + j * 1_000
  if (!jobEndedAt(j)) {
    const processed = Math.min(total - 1, 2_000 * (j % 7) + tick * 300)
    return { jobId: `job${j}`, status: 'running', phase: 'apply', progress: processed / total, processed, total, summary: { commits: tick } }
  }
  const refused = j % 4 === 0 ? 12 : 0
  return {
    jobId: `job${j}`, status: j === 9 ? 'cancelled' : j === 27 ? 'failed' : 'completed', phase: 'done', progress: 1, processed: total, total,
    ...(j === 27 ? { error: 'the draft was closed while it ran' } : {}),
    summary: {
      changed: total - 3_000, unchanged: 2_000, missing: j % 2 ? 40 : 0, deletedInDraft: 0, conflicts: 900, unconvertible: j % 8 === 6 ? 60 : 0,
      refused: { count: refused, byReason: refused ? { write_refused: refused } : {}, examples: [] }, commits: Math.ceil(total / 10_000),
    },
  }
}
function seedJobs() {
  const tracked = (j: number): TrackedJob => ({
    jobId: `job${j}`, ...GRAPH_WRITE, viewId: 'v1', op: JOB_OPS[j % JOB_OPS.length]!,
    targetLabel: ['every Table in this view', 'the children of Orders', 'entities with owner', '1,204 selected entities'][j % 4]!,
    startedAt: new Date(Date.now() - (JOBS - j) * 60_000).toISOString(), job: jobAt(j, 0),
  })
  openTimed(() => { for (let j = 0; j < JOBS; j++) usePropertyJobsStore.getState().track(tracked(j)) },
    () => document.querySelectorAll('[aria-label="Changes on this draft"] li').length === JOBS)
}
/** When the draft's data key moved (performance.now()): what its counts and catalog are read by. */
const keyMoves: number[] = []
function DraftKeyProbe() {
  const draftKey = useDraftDataKey()
  useEffect(() => { keyMoves.push(performance.now()) }, [draftKey])
  return null
}
function JobsRail() {
  const jobs = useDraftPropertyJobs(useBranchStore((s) => s.graphId), useBranchStore((s) => s.currentBranchId))
  return (
    <aside className="w-[clamp(380px,30vw,520px)] h-full overflow-y-auto custom-scrollbar border-l border-glass-border bg-canvas-elevated shadow-lg shadow-black/20 p-4">
      <h2 className="mb-3 text-sm font-display font-semibold text-ink">Property Manager</h2>
      <PropertyJobsPanel jobs={jobs} />
      <DraftKeyProbe />
    </aside>
  )
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
    if (fixture === 'multi-entity') await compareAndStage('owner', 20)
    if (fixture === 'multi-relationship') await compareAndStage('frequency', 8)
    if (fixture === 'cleanup-merge') {
      await until(() => report.openMs)
      const list = document.querySelector<HTMLElement>('[role=list][aria-label="Values to merge"]')!
      const groups = () => [...list.querySelectorAll<HTMLElement>('[role=listitem]')]
      await step('scroll', async () => {
        const scroller = list.parentElement!
        for (let k = 1; k <= 10; k++) { scroller.scrollTop = (scroller.scrollHeight * k) / 10; await new Promise((r) => setTimeout(r, 60)) }
        for (let k = 9; k >= 0; k--) { scroller.scrollTop = (scroller.scrollHeight * k) / 10; await new Promise((r) => setTimeout(r, 60)) }
      })
      // Six groups turned off, two of them on again.
      await step('toggle', async () => {
        for (const k of [0, 1, 2, 3, 4, 5, 2, 4]) {
          groups()[k]!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
          await frame()
        }
      })
      await step('canonical', async () => {
        const group = groups().find((g) => g.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked)!
        const radio = group.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!
        radio.click()
        await until(() => radio.checked)
      })
      // How many values the merge now makes one with another, as the dialog says it.
      const merges = /Merges ([\d,]+) value/.exec(document.querySelector('[role=dialog]')?.textContent ?? '')?.[1]
      report.checks = { values: TEAM_VALUES.length, merges: Number(merges?.replace(/,/g, '') ?? 0) }
    }
    if (fixture === 'jobs-panel') {
      await until(() => report.openMs)
      let started = 0
      await step('ticking', async () => {
        started = performance.now()
        for (let tick = 1; tick <= 100; tick++) {
          for (let j = 0; j < JOBS; j++) if (!jobEndedAt(j)) usePropertyJobsStore.getState().update(`job${j}`, jobAt(j, tick))
          await new Promise((r) => setTimeout(r, 100))
        }
      })
      const moves = keyMoves.filter((t) => t >= started).length
      report.checks = { draftKeyMoves: moves, seconds: Math.round((performance.now() - started) / 1000) }
      if (moves > 1) throw new Error(`the draft's data key moved ${moves} times in ${report.checks.seconds} s while its jobs ran — at most once per 30 s`)
    }
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
    if (fixture === 'multi-entity') seedEntities()
    if (fixture === 'multi-relationship') seedRelationships()
    if (fixture === 'cleanup-merge') openTimed(() => usePropertyJobsStore.getState().requestOp({ kind: 'mapValues', key: 'team' }), mergeShown)
    if (fixture === 'jobs-panel') seedJobs()
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
  if (BULK) {
    return (
      <ProviderOverride value={{
        provider, isLoading: false, error: null, scopeKind: 'ready', workspaceId: 'ws1', dataSourceId: 'ds1', providerReady: true, providerVersion: 1,
      } as never}>
        <div className="fixed inset-0 flex bg-canvas">
          <div className="flex-1 min-w-0" style={DOTS} />
          {fixture === 'multi-entity' && <EntityDrawer canEdit />}
          {fixture === 'multi-relationship' && <RelationshipDrawer canEdit />}
          {fixture === 'jobs-panel' && <JobsRail />}
        </div>
        {fixture === 'cleanup-merge' && <PropertyOpHost viewId="v1" graphWrite={GRAPH_WRITE} knownEntityTypes={TYPES} />}
        <NotificationStack />
      </ProviderOverride>
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
