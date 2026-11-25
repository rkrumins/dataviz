/**
 * Visual harness for the enable copy's review (`BootstrapProgress` → `BootstrapReviewSection`,
 * `ConnectionCopiesResolver`): what a manager sees when the source holds what version history can't
 * keep exactly as it is, and the report afterwards — the REAL components and their queries, against
 * an in-memory API. No backend, no auth.
 *
 *   npm run harness
 *   open http://localhost:5199/enable-review-harness.html?view=card&theme=dark
 *
 *   view   card (the data-source panel) | bar (the canvas strip) | resolver | done | failed
 *   theme  `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { BootstrapProgress } from '../features/versioning/components/BootstrapProgress'
import { ConnectionCopiesResolver } from '../features/versioning/components/ConnectionCopiesResolver'
import type { BootstrapJob, BootstrapReviewConnection, BootstrapReviewValue } from '../services/versioningApiService'
import { usePreferencesStore } from '../store/preferences'

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'card'
const dark = params.get('theme') === 'dark'

MotionGlobalConfig.skipAnimations = true
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'
document.head.appendChild(still)

const WS = 'ws_sales'
const DS = 'ds_sales'

const CONNECTIONS: BootstrapReviewConnection[] = [
  {
    entityId: 'urn:li:dataset:orders|FEEDS|urn:li:dataset:revenue', edgeType: 'FEEDS',
    source: 'urn:li:dataset:orders', target: 'urn:li:dataset:revenue',
    versions: [
      { seq: 1, count: 2, ids: ['f1', 'f7'], confidence: 0.9,
        properties: { 'my prop': 'val1', schedule: 'hourly', owner: 'ana', since: '2024-01-01' } },
      { seq: 2, count: 1, ids: ['f9'], confidence: 0.6,
        properties: { 'my prop': 'val2', schedule: 'daily', sla: '4h' } },
    ],
    clashing: ['my prop', 'schedule', 'owner', 'since', 'sla', '@confidence'],
    choice: { rule: 'merge', excludeCopies: [], values: { schedule: 2 }, excludeProperties: [] },
  },
  {
    entityId: 'urn:li:dataset:users|CALLS|urn:li:dataset:events', edgeType: 'CALLS',
    source: 'urn:li:dataset:users', target: 'urn:li:dataset:events',
    versions: [
      { seq: 1, count: 1, ids: ['c1'], confidence: null, properties: { at: 'mon', retries: 3 } },
      { seq: 2, count: 1, ids: ['c2'], confidence: null, properties: { at: 'tue', retries: 3 } },
    ],
    clashing: ['at'],
    choice: null,
  },
]

const VALUES: BootstrapReviewValue[] = [
  { entityId: 'urn:li:dataset:orders', seq: 0, entityKind: 'node', name: 'Orders', property: 'score',
    problem: 'nan', storedAs: 'NaN' },
  { entityId: 'f1', seq: 0, entityKind: 'edge', edgeType: 'FEEDS', source: 'urn:li:dataset:orders',
    target: 'urn:li:dataset:revenue', property: 'note', problem: 'nul', storedAs: 'checked by ops' },
]

const REVIEW_JOB: BootstrapJob = {
  jobId: 'vjob_1', graphId: 'g_sales', status: 'needs_decision', phase: 'awaiting_decision',
  awaiting: 'review', processed: 1_284_200, total: 1_284_200, percent: 72, report: null,
  review: {
    fingerprint: 'rv_1',
    copies: {
      connections: 37, versions: 81, copies: 96,
      sample: CONNECTIONS.map((c) => ({ entityId: c.entityId, edgeType: c.edgeType, source: c.source,
        target: c.target, versions: c.versions.length, copies: c.versions.reduce((n, v) => n + v.count, 0) })),
    },
    values: { count: 12, items: 9, byProblem: { nan: 9, nul: 3 }, sample: VALUES },
    decision: null,
  },
}

const REPORT = {
  checks: [
    { key: 'nodes_seen', ok: true, blocking: true, detail: 'scanned 412,880 of 412,880 items' },
    { key: 'edges_seen', ok: true, blocking: true, detail: 'scanned 871,320 of 871,320 connections' },
    { key: 'properties_kept', ok: true, blocking: true, detail: 'every property of every item and connection kept' },
    { key: 'edge_sample_matches', ok: true, blocking: true, detail: '64 of 64 re-checked connections match exactly' },
    { key: 'review_decided', ok: true, blocking: true, detail: '37 of 37 connection(s) held for review copied as decided' },
  ],
  source: { nodes: 412_880, edges: 871_320 }, stored: { nodes: 412_880, edges: 871_250 }, labels: {}, edgeTypes: {},
  sampleChecked: 64, sampleMismatched: [], mergedDuplicateConnections: 33, resolvedConnections: 37,
  valuesStoredAsText: 12, edgeSampleChecked: 64, merkle: 'inline' as const,
}

const JOBS: Record<string, BootstrapJob> = {
  card: REVIEW_JOB,
  bar: REVIEW_JOB,
  done: { ...REVIEW_JOB, status: 'completed', phase: null, percent: 100, awaiting: null, report: REPORT },
  failed: {
    ...REVIEW_JOB, status: 'failed', phase: 'validate', awaiting: null,
    error: 'The source graph changed while we were copying it, so the copy can’t be trusted. Retry when the graph is quiet.',
    failure: { code: 'integrity', action: 'restart' },
    report: { ...REPORT, checks: [
      { key: 'edge_sample_matches', ok: false, blocking: true, detail: '61 of 64 re-checked connections match exactly' },
      ...REPORT.checks.filter((c) => c.key !== 'edge_sample_matches')] },
  },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
  if (url.pathname.endsWith('/graph/bootstrap/review')) {
    return json({ items: url.searchParams.get('kind') === 'values' ? VALUES : CONNECTIONS, next: null })
  }
  if (url.pathname.endsWith('/graph/bootstrap/review/choice')) return json(JSON.parse(String(init?.body ?? '{}')))
  if (url.pathname.endsWith('/graph/bootstrap/status')) return json(JOBS[view] ?? REVIEW_JOB)
  return json({}, 404)
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })

export function Harness() {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }, [setTheme])
  const job = JOBS[view] ?? REVIEW_JOB
  return (
    <div className="min-h-screen bg-canvas p-4 text-ink sm:p-6">
      <MemoryRouter>
        <h1 className="mb-4 text-sm font-semibold text-ink">Enable version control · {view}</h1>
        {view === 'resolver' ? (
          <ConnectionCopiesResolver wsId={WS} dataSourceId={DS} policy={{ rule: 'merge', excludeProperties: [] }} onClose={() => {}} />
        ) : (
          <div className={view === 'bar' ? 'max-w-5xl rounded-xl border border-glass-border overflow-hidden' : 'max-w-2xl'}>
            <BootstrapProgress job={job} wsId={WS} dataSourceId={DS} variant={view === 'bar' ? 'bar' : 'card'} />
          </div>
        )}
      </MemoryRouter>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
)
