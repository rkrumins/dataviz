# Freshness Job Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ingestion → Freshness tab show what a rebuild is actually doing, link out to Job History for depth, and stop the provider-refresh dialogs from under-reporting what they did.

**Architecture:** One polled `listJobsGlobal` query joins in-flight jobs to fleet rows by data-source id (never per-row SSE — the browser caps concurrent connections at ~6). Job History's own `PhaseStepper` moves into the module both surfaces already import, so Freshness renders the *same* component rather than a fork. Navigation reuses the existing URL-driven job filters. The batch runner stops discarding the per-source `actions`/`deferred` it already receives.

**Tech Stack:** React 18 + TypeScript, TanStack Query, react-router-dom, Radix UI, framer-motion, Tailwind, Vitest + Testing Library. Backend: FastAPI + Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-07-21-freshness-job-visibility-design.md`

## Global Constraints

- **Plain-language, white-label copy.** Never show internal scope names (`rollups`, `read-caches`) in the UI, and never hardcode a brand name. Existing convention: `FreshnessRow.tsx` header comment.
- **Permission model: hide, don't disable.** Row actions are hidden entirely when `usePermission('workspace:datasource:manage', row.workspaceId)` is false — a disabled control would just 403 on click.
- **Radix dropdowns use `modal={false}`.** A modal Radix dropdown that unmounts while open leaves `body { pointer-events: none }` and freezes the page.
- **Portaled popovers must not use `AnimatePresence` + `exit`.** An interrupted exit strands an invisible click-blocker over the page. Animate in only.
- **Never render a phase or percentage the data doesn't support.** An unrecognized `currentPhase`, a missing job, or a failed jobs query all fall back to the plain `Recomputing` badge with no progress bar.
- **Frontend tests:** run from `frontend/` with `npx vitest run <path>`.
- **Backend tests:** run in the dev container: `docker exec synodic-dev-viz-service-1 sh -lc 'cd /app && PYTHONPATH=/app python -m pytest <path> -q'`.
- **TypeScript baseline must not regress:** `cd frontend && npx tsc --noEmit` before and after.

---

### Task 1: Move the phase vocabulary and `PhaseStepper` into the shared module

Job History owns the pipeline's phase names and its four-segment stepper, both private to `JobRow.tsx`. Freshness needs them. Move — do not copy — so one vocabulary exists.

**Files:**
- Modify: `frontend/src/components/admin/job-history/shared.tsx` (append a new section)
- Modify: `frontend/src/components/admin/job-history/JobRow.tsx:19-137` (delete the moved code, import it back)
- Test: `frontend/src/components/admin/job-history/phases.test.tsx` (create)

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `job-history/shared.tsx`:
  - `PHASE_LABELS: Record<string, string>`
  - `phaseLabel(currentPhase: string | null | undefined): string`
  - `PHASES: Array<{ id: string; label: string; statKey: string }>`
  - `PHASE_BANDS: Record<string, [number, number]>`
  - `PhaseStepper(props: { currentPhase: string | null | undefined; runStats: Record<string, number | string | Record<string, number>> | null | undefined; status: string }): JSX.Element | null`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/admin/job-history/phases.test.tsx`:

```tsx
/**
 * The pipeline's phase vocabulary and stepper live in shared.tsx so both
 * Job History and the Freshness cockpit render the SAME phase names. Two
 * hard-coded copies would drift the moment the pipeline gains a phase.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PHASES, PHASE_BANDS, PHASE_LABELS, PhaseStepper, phaseLabel } from './shared'

describe('phase vocabulary', () => {
    it('names every pipeline phase', () => {
        expect(PHASE_LABELS.extracting).toBe('Extracting lineage edges')
        expect(PHASE_LABELS.computing).toBe('Computing rollups')
        expect(PHASE_LABELS.reconciling).toBe('Reconciling existing aggregated edges')
        expect(PHASE_LABELS.applying).toBe('Writing aggregated edges')
    })

    it('falls back to a generic label for an unknown phase', () => {
        expect(phaseLabel('teleporting')).toBe('Processing lineage edges')
        expect(phaseLabel(null)).toBe('Processing lineage edges')
    })

    it('keeps PHASES and PHASE_BANDS aligned with PHASE_LABELS', () => {
        expect(PHASES.map(p => p.id)).toEqual(['extracting', 'computing', 'reconciling', 'applying'])
        for (const p of PHASES) {
            expect(PHASE_LABELS[p.id]).toBeTruthy()
            expect(PHASE_BANDS[p.id]).toHaveLength(2)
        }
    })
})

describe('PhaseStepper', () => {
    it('renders all four segments for a running job', () => {
        render(<PhaseStepper currentPhase="computing" runStats={null} status="running" />)
        for (const label of ['Extract', 'Compute', 'Reconcile', 'Apply']) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
    })

    it('renders per-phase durations once completed', () => {
        render(<PhaseStepper currentPhase={null} runStats={{ extract_s: 62 }} status="completed" />)
        expect(screen.getByText('1m 2s')).toBeInTheDocument()
    })

    it('renders nothing for a job with no phase that has not completed', () => {
        const { container } = render(<PhaseStepper currentPhase={null} runStats={null} status="pending" />)
        expect(container).toBeEmptyDOMElement()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/job-history/phases.test.tsx`
Expected: FAIL — `shared.tsx` does not export `PhaseStepper` / `PHASE_LABELS`.

- [ ] **Step 3: Move the code into `shared.tsx`**

Append to `frontend/src/components/admin/job-history/shared.tsx` (it already imports `cn` and defines `formatDuration`, so no new imports are needed):

```tsx
// ── Aggregation pipeline phases ─────────────────────────────────────
//
// Moved here from JobRow.tsx so the Freshness cockpit renders the SAME
// stepper and the SAME phase names. Two hard-coded copies of the
// pipeline's vocabulary drift the moment a phase is added.

// UI phase visibility. Maps the backend's short phase IDs (emitted by
// the aggregation pipeline's EXTRACT → COMPUTE → RECONCILE → APPLY
// stages) to operator-readable status labels. ``null`` / unrecognized
// values fall back to the generic "Processing lineage edges" string so
// legacy / non-FalkorDB paths keep the old UX.
export const PHASE_LABELS: Record<string, string> = {
    extracting: 'Extracting lineage edges',
    computing: 'Computing rollups',
    reconciling: 'Reconciling existing aggregated edges',
    applying: 'Writing aggregated edges',
}

export function phaseLabel(currentPhase: string | null | undefined): string {
    if (currentPhase && PHASE_LABELS[currentPhase]) {
        return PHASE_LABELS[currentPhase]
    }
    return 'Processing lineage edges'
}

// Pipeline phases in execution order — drives the stepper and the
// per-phase duration readout (keys emitted in ``job.runStats``).
export const PHASES: Array<{ id: string; label: string; statKey: string }> = [
    { id: 'extracting', label: 'Extract', statKey: 'extract_s' },
    { id: 'computing', label: 'Compute', statKey: 'compute_s' },
    { id: 'reconciling', label: 'Reconcile', statKey: 'reconcile_s' },
    { id: 'applying', label: 'Apply', statKey: 'apply_s' },
]

// Overall-progress band each phase occupies. MUST mirror the pipeline's
// _progress_pct mapping in falkordb_materialize.py (extract 0-45,
// compute 45-55, reconcile 55-75, apply 75-100).
export const PHASE_BANDS: Record<string, [number, number]> = {
    extracting: [0, 45],
    computing: [45, 55],
    reconciling: [55, 75],
    applying: [75, 100],
}

/**
 * Four-segment EXTRACT → COMPUTE → RECONCILE → APPLY stepper.
 * Running: segments before the current phase are done, the current one
 * pulses, later ones are dormant. Completed: all done, with the
 * per-phase durations from ``runStats`` under each segment.
 */
export function PhaseStepper({ currentPhase, runStats, status }: {
    currentPhase: string | null | undefined
    runStats: Record<string, number | string | Record<string, number>> | null | undefined
    status: string
}) {
    const completed = status === 'completed'
    const currentIdx = currentPhase ? PHASES.findIndex(p => p.id === currentPhase) : -1
    if (!completed && currentIdx < 0) return null
    return (
        <div className="flex items-start gap-1.5">
            {PHASES.map((p, i) => {
                const done = completed || i < currentIdx
                const active = !completed && i === currentIdx
                const raw = runStats?.[p.statKey]
                const secs = typeof raw === 'number' ? raw : null
                return (
                    <div key={p.id} className="flex-1 min-w-0">
                        <div className={cn(
                            'h-1 rounded-full transition-colors',
                            done ? 'bg-indigo-500/70'
                                : active ? 'bg-gradient-to-r from-indigo-500 to-violet-400 animate-pulse'
                                : 'bg-black/[0.06] dark:bg-white/[0.08]',
                        )} />
                        <div className="mt-1 flex items-center justify-between gap-1">
                            <span className={cn(
                                'text-[9px] font-bold uppercase tracking-wider truncate',
                                active ? 'text-indigo-400' : done ? 'text-ink-muted' : 'text-ink-muted/35',
                            )}>{p.label}</span>
                            {secs != null && (
                                <span className="text-[9px] tabular-nums text-ink-muted/60 flex-shrink-0">
                                    {formatDuration(secs)}
                                </span>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
```

- [ ] **Step 4: Delete the originals from `JobRow.tsx` and import them back**

In `frontend/src/components/admin/job-history/JobRow.tsx`, delete lines 19-50 (`PHASE_LABELS`, `phaseLabel`, `PHASES`, `PHASE_BANDS`) and the whole `PhaseStepper` function (lines 98-137). Then extend the existing `./shared` import:

```tsx
import {
    formatDuration, timeAgo, triggerLabel, STATUS_CONFIG, type DataSourceMeta,
    PHASES, PHASE_BANDS, PhaseStepper, phaseLabel,
} from './shared'
```

`historicalEta` stays in `JobRow.tsx` — it uses `PHASES` and `PHASE_BANDS`, now imported. Nothing else in the file changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/job-history/`
Expected: PASS — the new `phases.test.tsx` plus every pre-existing job-history test, proving a move rather than a fork.

- [ ] **Step 6: Verify types**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors versus the baseline.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/admin/job-history/shared.tsx frontend/src/components/admin/job-history/JobRow.tsx frontend/src/components/admin/job-history/phases.test.tsx
git commit -m "refactor: move pipeline phase vocabulary and PhaseStepper into job-history/shared"
```

---

### Task 2: `jobHistoryPath` helper and the drawer's Job History link

**Files:**
- Modify: `frontend/src/components/admin/job-history/shared.tsx` (append)
- Modify: `frontend/src/components/admin/Freshness/FreshnessDrawer.tsx`
- Test: `frontend/src/components/admin/job-history/jobHistoryPath.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `jobHistoryPath(opts?: { dataSourceId?: string; status?: string[] }): string` exported from `job-history/shared.tsx`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/admin/job-history/jobHistoryPath.test.ts`:

```ts
/**
 * Deep links into Job History need no new routing: IngestionPage reads
 * ?tab=, and paramsToFilters already parses repeatable dataSourceId and
 * status params. This helper must emit exactly what paramsToFilters reads,
 * so the two are asserted against each other rather than against a string.
 */
import { describe, expect, it } from 'vitest'
import { jobHistoryPath, paramsToFilters } from './shared'

describe('jobHistoryPath', () => {
    it('targets the jobs tab', () => {
        expect(jobHistoryPath()).toBe('/ingestion?tab=jobs')
    })

    it('emits params paramsToFilters can read back', () => {
        const path = jobHistoryPath({ dataSourceId: 'ds_1', status: ['running', 'pending'] })
        const filters = paramsToFilters(new URLSearchParams(path.split('?')[1]))
        expect(filters.dataSourceId).toEqual(['ds_1'])
        expect(filters.status).toEqual(['running', 'pending'])
    })

    it('omits absent options', () => {
        expect(jobHistoryPath({ dataSourceId: 'ds_1' })).toBe('/ingestion?tab=jobs&dataSourceId=ds_1')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/job-history/jobHistoryPath.test.ts`
Expected: FAIL — `jobHistoryPath` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `frontend/src/components/admin/job-history/shared.tsx`:

```tsx
/**
 * Deep link into Ingestion → Job History. Emits exactly the params
 * ``paramsToFilters`` reads, so a link and the filter state it produces
 * cannot drift. No new routing: IngestionPage already drives tabs off
 * ``?tab=``.
 */
export function jobHistoryPath(opts: { dataSourceId?: string; status?: string[] } = {}): string {
    const p = new URLSearchParams()
    p.set('tab', 'jobs')
    if (opts.dataSourceId) p.append('dataSourceId', opts.dataSourceId)
    for (const s of opts.status ?? []) p.append('status', s)
    return `/ingestion?${p.toString()}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/admin/job-history/jobHistoryPath.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the drawer link**

In `frontend/src/components/admin/Freshness/FreshnessDrawer.tsx`, add the imports:

```tsx
import { Link } from 'react-router-dom'
import { jobHistoryPath } from '../job-history/shared'
```

and render this link in the drawer header, immediately after `FreshnessDrawer.tsx:419` (the `{doc?.name || dsId}` heading). The component's prop is `dsId: string | null`, so guard it — a null id must not produce a link to an unfiltered job list:

```tsx
{dsId && (
    <Link
        to={jobHistoryPath({ dataSourceId: dsId })}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
    >
        Open in Job History
        <ArrowUpRight className="w-3 h-3" />
    </Link>
)}
```

Add `ArrowUpRight` to the file's existing `lucide-react` import.

- [ ] **Step 6: Verify the drawer still renders**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS — the existing drawer tests in `Freshness.test.tsx` are unaffected.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/admin/job-history/shared.tsx frontend/src/components/admin/job-history/jobHistoryPath.test.ts frontend/src/components/admin/Freshness/FreshnessDrawer.tsx
git commit -m "feat: jobHistoryPath deep-link helper and a Job History link in the freshness drawer"
```

---

### Task 3: `useActiveJobs` — one polled query for every in-flight job

**Files:**
- Create: `frontend/src/components/admin/Freshness/useActiveJobs.ts`
- Test: `frontend/src/components/admin/Freshness/useActiveJobs.test.tsx` (create)

**Interfaces:**
- Consumes: `aggregationService.listJobsGlobal(filters)`, `AggregationJobResponse`, `PaginatedJobsResponse` from `@/services/aggregationService`.
- Produces:
  - `ACTIVE_JOB_CAP = 100`
  - `ACTIVE_JOBS_KEY: readonly ['freshness', 'activeJobs']`
  - `useActiveJobs(enabled?: boolean): { byDataSource: Map<string, AggregationJobResponse>; truncated: boolean }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/admin/Freshness/useActiveJobs.test.tsx`:

```tsx
/**
 * ONE query for every in-flight job, joined by data source. Never one
 * stream per row: JobRow opens an SSE connection per active row and the
 * browser caps concurrent connections at ~6, so 20+ rebuilding rows would
 * starve. This is a SECONDARY signal — the table must render without it.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listJobsGlobal } = vi.hoisted(() => ({ listJobsGlobal: vi.fn() }))
vi.mock('@/services/aggregationService', () => ({
    aggregationService: { listJobsGlobal },
}))

import { ACTIVE_JOB_CAP, useActiveJobs } from './useActiveJobs'

function wrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const job = (id: string, dsId: string) => ({
    id, dataSourceId: dsId, status: 'running', triggerSource: 'api', progress: 40,
    totalEdges: 10, processedEdges: 4, createdEdges: 0, batchSize: 1000,
    resumable: false, retryCount: 0, createdAt: new Date().toISOString(),
})

beforeEach(() => vi.clearAllMocks())

describe('useActiveJobs', () => {
    it('asks only for in-flight jobs, capped', async () => {
        listJobsGlobal.mockResolvedValue({ items: [], total: 0, limit: ACTIVE_JOB_CAP, offset: 0 })
        renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(listJobsGlobal).toHaveBeenCalledWith({
            status: ['running', 'pending'],
            limit: ACTIVE_JOB_CAP,
        }))
    })

    it('indexes jobs by data source', async () => {
        listJobsGlobal.mockResolvedValue({
            items: [job('j1', 'ds_a'), job('j2', 'ds_b')], total: 2, limit: ACTIVE_JOB_CAP, offset: 0,
        })
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(result.current.byDataSource.size).toBe(2))
        expect(result.current.byDataSource.get('ds_a')?.id).toBe('j1')
        expect(result.current.truncated).toBe(false)
    })

    it('reports truncation when more jobs exist than were returned', async () => {
        listJobsGlobal.mockResolvedValue({
            items: [job('j1', 'ds_a')], total: 500, limit: ACTIVE_JOB_CAP, offset: 0,
        })
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(result.current.truncated).toBe(true))
    })

    it('degrades to an empty map when the query fails', async () => {
        listJobsGlobal.mockRejectedValue(new Error('403'))
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(listJobsGlobal).toHaveBeenCalled())
        expect(result.current.byDataSource.size).toBe(0)
        expect(result.current.truncated).toBe(false)
    })

    it('does not fetch when disabled', () => {
        renderHook(() => useActiveJobs(false), { wrapper })
        expect(listJobsGlobal).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/useActiveJobs.test.tsx`
Expected: FAIL — cannot resolve `./useActiveJobs`.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/components/admin/Freshness/useActiveJobs.ts`:

```ts
/**
 * useActiveJobs — every in-flight aggregation job in ONE polled query,
 * indexed by data source, so the Freshness table can show a live phase and
 * percentage per row.
 *
 * NOT one stream per row: ``JobRow`` opens an SSE connection per active
 * row, and HTTP/1.1 caps a browser at ~6 connections per host — with 20+
 * rebuilding rows that starves the page. A badge does not need per-second
 * fidelity, so the fleet's own 30s cadence is enough.
 *
 * This is a SECONDARY signal. If it fails, 403s, or is capped, rows fall
 * back to the plain "Recomputing" badge — the cockpit must never break, and
 * must never show a phase it cannot substantiate.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { aggregationService, type AggregationJobResponse } from '@/services/aggregationService'

/** The jobs endpoint validates `limit` with `Query(25, ge=1, le=100)`
 *  (aggregation.py `list_jobs_global`) — asking for more is a hard 422
 *  before the handler runs, which would silently kill this whole feature.
 *  Past this we stop claiming to know a row's phase rather than showing a
 *  stale one. */
export const ACTIVE_JOB_CAP = 100

/** Matches the fleet query's cadence (useFreshness FLEET_POLL_MS). */
const ACTIVE_JOBS_POLL_MS = 30_000

export const ACTIVE_JOBS_KEY = ['freshness', 'activeJobs'] as const

export interface ActiveJobs {
    /** dataSourceId → its in-flight job. Empty when unavailable. */
    byDataSource: Map<string, AggregationJobResponse>
    /** More in-flight jobs exist than were returned; un-joined rows must
     *  fall back to the plain badge. */
    truncated: boolean
}

export function useActiveJobs(enabled = true): ActiveJobs {
    const { data } = useQuery({
        queryKey: ACTIVE_JOBS_KEY,
        queryFn: () => aggregationService.listJobsGlobal({
            status: ['running', 'pending'],
            limit: ACTIVE_JOB_CAP,
        }),
        enabled,
        staleTime: 15_000,
        refetchInterval: ACTIVE_JOBS_POLL_MS,
        // Secondary signal: fail fast and stay quiet rather than retrying
        // a 403 for an operator who simply can't read the job table.
        retry: false,
    })

    const truncated = !!data && data.total > data.items.length

    const warned = useRef(false)
    useEffect(() => {
        if (truncated && !warned.current) {
            warned.current = true
            console.warn(
                `[freshness] ${data?.total} active jobs exceed the ${ACTIVE_JOB_CAP} join cap — ` +
                'rows beyond it show no phase rather than a stale one.',
            )
        }
    }, [truncated, data?.total])

    return useMemo(() => ({
        byDataSource: new Map((data?.items ?? []).map(j => [j.dataSourceId, j])),
        truncated,
    }), [data?.items, truncated])
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/useActiveJobs.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/admin/Freshness/useActiveJobs.ts frontend/src/components/admin/Freshness/useActiveJobs.test.tsx
git commit -m "feat: useActiveJobs — one polled in-flight job query indexed by data source"
```

---

### Task 4: Row badge shows live phase, percentage and a progress bar

**Files:**
- Modify: `frontend/src/components/admin/Freshness/FreshnessRow.tsx` (`FreshnessBadges`, `Props`)
- Modify: `frontend/src/components/admin/Freshness/index.tsx` (call `useActiveJobs`, pass the job down)
- Test: `frontend/src/components/admin/Freshness/Freshness.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `useActiveJobs` (Task 3), `jobHistoryPath` (Task 2), `PHASE_LABELS` (Task 1).
- Produces: `FreshnessBadges({ row, job }: { row: FreshnessRowData; job?: AggregationJobResponse })` — `job` optional. `FreshnessRow`'s `Props` gains `job?: AggregationJobResponse` and `colSpan: number` (required — Task 5's panel row spans the table, and `index.tsx` already has `COLS = 6` at `index.tsx:47`).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/admin/Freshness/Freshness.test.tsx`:

```tsx
describe('live rebuild progress in the row', () => {
    const rebuildingRow: FreshnessRowData = {
        dataSourceId: 'ds_live', workspaceId: 'ws1', providerId: 'p1',
        name: 'Nexus Lineage', providerName: 'Sandbox',
        aggregationStatus: 'ready', staleReason: 'source_changed',
        runningJobId: 'job_1', lastAggregatedAt: recent,
    }

    it('shows the phase and percentage when a job is joined', () => {
        render(
            <table><tbody>
                <FreshnessRow
                    row={rebuildingRow}
                    job={{ id: 'job_1', dataSourceId: 'ds_live', status: 'running',
                           currentPhase: 'computing', progress: 62 } as never}
                    onOpenDrawer={() => {}} onRefresh={() => {}} colSpan={6}
                />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.getByText(/Computing rollups/)).toBeInTheDocument()
        expect(screen.getByText(/62%/)).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
    })

    it('falls back to a bare badge with no bar when no job is joined', () => {
        render(
            <table><tbody>
                <FreshnessRow row={rebuildingRow} onOpenDrawer={() => {}} onRefresh={() => {}} colSpan={6} />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.getByText('Recomputing')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })

    it('never guesses at an unrecognized phase', () => {
        render(
            <table><tbody>
                <FreshnessRow
                    row={rebuildingRow}
                    job={{ id: 'job_1', dataSourceId: 'ds_live', status: 'running',
                           currentPhase: 'teleporting', progress: 62 } as never}
                    onOpenDrawer={() => {}} onRefresh={() => {}} colSpan={6}
                />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.getByText('Recomputing')).toBeInTheDocument()
        expect(screen.queryByText(/62%/)).not.toBeInTheDocument()
    })

    it('links the badge to Job History for this source', () => {
        render(
            <table><tbody>
                <FreshnessRow
                    row={rebuildingRow}
                    job={{ id: 'job_1', dataSourceId: 'ds_live', status: 'running',
                           currentPhase: 'computing', progress: 62 } as never}
                    onOpenDrawer={() => {}} onRefresh={() => {}} colSpan={6}
                />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.getByRole('link', { name: /Computing rollups/ }))
            .toHaveAttribute('href', '/ingestion?tab=jobs&dataSourceId=ds_live')
    })
})
```

Add `import { FreshnessRow } from './FreshnessRow'` to the file's imports if it is not already present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/Freshness.test.tsx -t "live rebuild progress"`
Expected: FAIL — `FreshnessRow` accepts no `job` prop and renders no progressbar.

- [ ] **Step 3: Implement the badge change**

In `frontend/src/components/admin/Freshness/FreshnessRow.tsx`, add imports:

```tsx
import { Link } from 'react-router-dom'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { PHASE_LABELS, jobHistoryPath } from '../job-history/shared'
```

Change the signature and the `recomputing` branch of `FreshnessBadges`:

```tsx
export function FreshnessBadges({ row, job }: {
    row: FreshnessRowData
    job?: AggregationJobResponse
}) {
    const badges: React.ReactNode[] = []
    const state = freshnessState(row)
    // Only a RECOGNIZED phase earns a phase name and a bar. An unknown
    // phase id, a missing job, or a failed jobs query all fall back to the
    // bare badge — never a percentage we cannot substantiate.
    const phase = job?.currentPhase ? PHASE_LABELS[job.currentPhase] : undefined
    const pct = phase && typeof job?.progress === 'number'
        ? Math.min(100, Math.max(0, Math.round(job.progress)))
        : null
```

Replace the existing `state === 'recomputing'` branch body with:

```tsx
    } else if (state === 'recomputing') {
        badges.push(
            <Link key="recomputing" to={jobHistoryPath({ dataSourceId: row.dataSourceId })}
                className="outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded-full">
                <Badge
                    tone="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20"
                    Icon={Loader2} spin
                    label={pct != null ? `Recomputing · ${phase} · ${pct}%` : 'Recomputing'}
                    title="A lineage rebuild is running now. Open Job History for the full detail."
                />
            </Link>,
        )
    }
```

Then, immediately before the `if (badges.length === 0)` check, add the bar:

```tsx
    if (pct != null && state === 'recomputing') {
        badges.push(
            <ProgressBar key="bar" value={pct} className="w-full h-1 mt-1"
                label={`Rebuild progress for ${row.name || row.dataSourceId}`} />,
        )
    }
```

Finally extend the `Props` interface with `job?: AggregationJobResponse` and `colSpan: number`, and pass `job` through:

```tsx
            <td className="px-3 py-2 align-top">
                <FreshnessBadges row={row} job={job} />
            </td>
```

- [ ] **Step 4: Wire it in `index.tsx`**

In `frontend/src/components/admin/Freshness/index.tsx` add the import and the hook call beside `const fleet = useFleetFreshness()`:

```tsx
import { useActiveJobs } from './useActiveJobs'
...
const activeJobs = useActiveJobs()
```

and pass the joined job plus the column count to each row:

```tsx
<FreshnessRow
    key={row.dataSourceId}
    row={row}
    job={activeJobs.byDataSource.get(row.dataSourceId)}
    colSpan={COLS}
    workspaceName={row.workspaceId ? workspaceName.get(row.workspaceId) : undefined}
    onOpenDrawer={setDrawerDsId}
    onRefresh={onRefresh}
    busy={busyDsId === row.dataSourceId}
/>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS — the four new tests plus every pre-existing Freshness test.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/admin/Freshness/FreshnessRow.tsx frontend/src/components/admin/Freshness/index.tsx frontend/src/components/admin/Freshness/Freshness.test.tsx
git commit -m "feat: freshness rows show live rebuild phase, percentage and progress bar"
```

---

### Task 5: Expandable panel with the shared stepper

**Files:**
- Modify: `frontend/src/components/admin/Freshness/FreshnessRow.tsx`
- Modify: `frontend/src/components/admin/Freshness/index.tsx` (expansion state)
- Test: `frontend/src/components/admin/Freshness/Freshness.test.tsx` (append)

**Interfaces:**
- Consumes: `PhaseStepper`, `phaseLabel`, `jobHistoryPath` (Tasks 1-2), `job` prop (Task 4).
- Produces: `FreshnessRow` gains `expanded?: boolean` and `onToggleExpand?: (dsId: string) => void`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/admin/Freshness/Freshness.test.tsx`, inside the `describe('live rebuild progress in the row')` block:

```tsx
    const runningJob = { id: 'job_1', dataSourceId: 'ds_live', status: 'running',
                         currentPhase: 'computing', progress: 62,
                         runStats: { extract_s: 62 } } as never

    function renderRow(props: Record<string, unknown> = {}) {
        return render(
            <table><tbody>
                <FreshnessRow row={rebuildingRow} job={runningJob} colSpan={6}
                    onOpenDrawer={() => {}} onRefresh={() => {}} {...props} />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
    }

    it('renders the four-phase stepper when expanded', () => {
        renderRow({ expanded: true })
        for (const label of ['Extract', 'Compute', 'Reconcile', 'Apply']) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
        expect(screen.getByRole('link', { name: /Open in Job History/ }))
            .toHaveAttribute('href', '/ingestion?tab=jobs&dataSourceId=ds_live')
    })

    it('renders no panel when collapsed', () => {
        renderRow({ expanded: false })
        expect(screen.queryByText('Reconcile')).not.toBeInTheDocument()
    })

    it('is not expandable without a joined job', () => {
        render(
            <table><tbody>
                <FreshnessRow row={rebuildingRow} colSpan={6} expanded
                    onOpenDrawer={() => {}} onRefresh={() => {}} />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.queryByText('Reconcile')).not.toBeInTheDocument()
    })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/Freshness.test.tsx -t "stepper"`
Expected: FAIL — no stepper is rendered.

- [ ] **Step 3: Implement the panel**

In `FreshnessRow.tsx` extend the imports:

```tsx
import { PHASE_LABELS, PhaseStepper, jobHistoryPath, phaseLabel } from '../job-history/shared'
import { ArrowUpRight } from 'lucide-react'
```

The component currently `return`s a single `<tr>`. Wrap that **existing, unmodified** `<tr>` — all six `<td>` cells stay exactly as they are — in a fragment, and add the panel row after its closing `</tr>`. Insert these two derivations just above the `return`:

```tsx
    // Only a row with a joined running job has anything to expand. No job,
    // no panel — an empty expander would be a dead affordance.
    const canExpand = !!job && !!job.currentPhase && PHASE_LABELS[job.currentPhase] != null
    const pct = job && typeof job.progress === 'number'
        ? Math.min(100, Math.max(0, Math.round(job.progress)))
        : 0
```

so the return becomes:

```tsx
    return (
        <>
            {/* The existing row, unchanged — same className, same six cells. */}
            <tr className="border-t border-glass-border hover:bg-black/[0.015] dark:hover:bg-white/[0.015] transition-colors">
                {/* … existing Source / Aggregation / Cache / Freshness /
                    Last activity / Actions cells, untouched … */}
            </tr>
            {expanded && canExpand && job && (
                <tr>
                    <td colSpan={colSpan} className="p-0">
                        <div className="mx-3 my-2 rounded-xl border border-indigo-500/20 bg-canvas-elevated p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-ink">
                                    {phaseLabel(job.currentPhase)}
                                </span>
                                <span className="text-[12px] font-bold text-indigo-400 tabular-nums">{pct}%</span>
                            </div>
                            <ProgressBar value={pct} className="h-2"
                                label={`Rebuild progress for ${row.name || row.dataSourceId}`} />
                            <PhaseStepper
                                currentPhase={job.currentPhase}
                                runStats={job.runStats}
                                status={job.status}
                            />
                            <div className="flex justify-end">
                                <Link
                                    to={jobHistoryPath({ dataSourceId: row.dataSourceId })}
                                    className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                    Open in Job History
                                    <ArrowUpRight className="w-3 h-3" />
                                </Link>
                            </div>
                        </div>
                    </td>
                </tr>
            )}
        </>
    )
```

Extend `Props` with `expanded?: boolean` and `onToggleExpand?: (dsId: string) => void`.

**Suppress the row-level bar while expanded** — two bars for one job is noise. Give `FreshnessBadges` a third prop and have `FreshnessRow` pass it:

```tsx
export function FreshnessBadges({ row, job, showProgressBar = true }: {
    row: FreshnessRowData
    job?: AggregationJobResponse
    showProgressBar?: boolean
}) {
```

Guard the bar push added in Task 4 with it:

```tsx
    if (pct != null && state === 'recomputing' && showProgressBar) {
```

and in the row's Freshness cell:

```tsx
<FreshnessBadges row={row} job={job} showProgressBar={!expanded} />
```

The badge keeps its phase and percentage either way — only the duplicated bar goes.

- [ ] **Step 4: Hold expansion state in `index.tsx`**

Add beside the other `useState` calls:

```tsx
const [expandedRow, setExpandedRow] = useState<string | null>(null)
```

and pass to `FreshnessRow`:

```tsx
    expanded={expandedRow === row.dataSourceId}
    onToggleExpand={(dsId) => setExpandedRow(cur => (cur === dsId ? null : dsId))}
```

Single-open accordion: expanding one row collapses another, so the table never grows unboundedly while 21 sources rebuild.

**Expected intermediate state — do not "fix" this.** After this task nothing in the UI triggers expansion: the panel is purely prop-driven and these tests drive `expanded` directly. The trigger arrives in Task 6, where the `recomputing` state's primary action ("View progress") calls `onToggleExpand`. Deliberately no chevron in the source cell — that cell's whole name block is already a button opening the freshness drawer, so a second competing affordance there would be worse than one labelled button.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/admin/Freshness/FreshnessRow.tsx frontend/src/components/admin/Freshness/index.tsx frontend/src/components/admin/Freshness/Freshness.test.tsx
git commit -m "feat: expandable freshness row with the shared four-phase stepper"
```

---

### Task 6: State-driven primary action plus `⋯` overflow

**Files:**
- Modify: `frontend/src/components/admin/Freshness/FreshnessRow.tsx`
- Modify: `frontend/src/components/admin/Freshness/index.tsx` (cancel handler)
- Test: `frontend/src/components/admin/Freshness/Freshness.test.tsx` (append)

**Interfaces:**
- Consumes: `freshnessState` (`./freshnessTriage`), `aggregationService.cancelJob(dataSourceId, jobId)`.
- Produces: `overflowActions(state: FreshnessState): RowAction[]` (exported for test); `primaryAction(state: FreshnessState): { label: string; kind: 'refresh' | 'expand'; scope?: RefreshScope; force?: boolean; firstBuild?: boolean }` exported from `FreshnessRow.tsx`; `FreshnessRow` gains `onCancelJob?: (dsId: string, jobId: string) => void`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/admin/Freshness/Freshness.test.tsx`:

```tsx
describe('state-driven row actions', () => {
    // Own fixture — this describe cannot see the one scoped to the
    // "live rebuild progress" block above.
    const actionRow: FreshnessRowData = {
        dataSourceId: 'ds_live', workspaceId: 'ws1', providerId: 'p1',
        name: 'Nexus Lineage', providerName: 'Sandbox',
        aggregationStatus: 'ready', staleReason: 'source_changed',
        runningJobId: 'job_1', lastAggregatedAt: recent,
    }

    it('maps every state to the action that state calls for', () => {
        expect(primaryAction('failed')).toMatchObject({ label: 'Retry rebuild', kind: 'refresh', scope: 'rollups', force: true })
        expect(primaryAction('recomputing')).toMatchObject({ label: 'View progress', kind: 'expand' })
        expect(primaryAction('queued')).toMatchObject({ label: 'Rebuild now', kind: 'refresh', scope: 'rollups' })
        expect(primaryAction('stale')).toMatchObject({ label: 'Rebuild now', kind: 'refresh', scope: 'rollups' })
        expect(primaryAction('neverBuilt')).toMatchObject({ label: 'Build lineage', kind: 'refresh', scope: 'rollups', firstBuild: true })
        expect(primaryAction('upToDate')).toMatchObject({ label: 'Refresh caches', kind: 'refresh', scope: 'read-caches' })
    })

    it('never repeats the primary action in the overflow, and offers no rebuild mid-rebuild', () => {
        expect(overflowActions('neverBuilt')).toEqual([])
        expect(overflowActions('recomputing').map(a => a.scope)).toEqual(['read-caches'])
        expect(overflowActions('upToDate').map(a => a.scope)).not.toContain('read-caches')
        expect(overflowActions('failed').map(a => a.scope)).not.toContain('rollups')
    })

    it('hides the whole action cluster without manage permission', () => {
        permissionFn.mockReturnValue(false)
        render(
            <table><tbody>
                <FreshnessRow row={actionRow} colSpan={6} onOpenDrawer={() => {}} onRefresh={() => {}} />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.queryByRole('button', { name: /View progress/ })).not.toBeInTheDocument()
        permissionFn.mockReturnValue(true)
    })
})
```

Add `primaryAction` and `overflowActions` to the `./FreshnessRow` import in the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/Freshness.test.tsx -t "state-driven row actions"`
Expected: FAIL — `primaryAction` is not exported.

- [ ] **Step 3: Implement the mapping and the button**

Add to `FreshnessRow.tsx`:

```tsx
import type { FreshnessState } from './freshnessTriage'

/**
 * The one action a row's state calls for, promoted out of the overflow so
 * an operator never hunts for it. ``recomputing`` deliberately maps to
 * "View progress" (opens the in-place panel) rather than "Cancel": Cancel
 * is destructive and must not be the easiest target on a table where 20+
 * rows can be rebuilding at once. It stays in the overflow.
 */
export function primaryAction(state: FreshnessState): {
    label: string
    kind: 'refresh' | 'expand'
    scope?: RefreshScope
    force?: boolean
    firstBuild?: boolean
} {
    switch (state) {
        case 'failed': return { label: 'Retry rebuild', kind: 'refresh', scope: 'rollups', force: true }
        case 'recomputing': return { label: 'View progress', kind: 'expand' }
        case 'queued':
        case 'stale': return { label: 'Rebuild now', kind: 'refresh', scope: 'rollups' }
        case 'neverBuilt': return { label: 'Build lineage', kind: 'refresh', scope: 'rollups', firstBuild: true }
        case 'upToDate':
        default: return { label: 'Refresh caches', kind: 'refresh', scope: 'read-caches' }
    }
}
```

**The overflow must not repeat the primary, and must not offer a rebuild to a row that is already rebuilding.** Replace the current `const actions = isNeverBuilt(row) ? NEVER_BUILT_ACTIONS : BUILT_ACTIONS` with a state-derived list matching the spec's table:

```tsx
/** Overflow scopes per state — the primary action's own scope is never
 *  repeated here, and a rebuilding row is not offered another rebuild
 *  (the backend would collapse it onto the running job anyway, so the
 *  menu item would be a lie). */
function overflowActions(state: FreshnessState): RowAction[] {
    const byScope = (s: RefreshScope) => BUILT_ACTIONS.find(a => a.scope === s)!
    switch (state) {
        case 'neverBuilt':
            return []
        case 'recomputing':
            return [byScope('read-caches')]
        case 'upToDate':
            return [byScope('clear'), byScope('rollups'), byScope('full')]
        case 'failed':
        case 'queued':
        case 'stale':
        default:
            return [byScope('read-caches'), byScope('clear'), byScope('full')]
    }
}
...
const actions = overflowActions(freshnessState(row))
```

Render the primary in the Actions cell, before the existing `DropdownMenu.Root`:

```tsx
{(() => {
    const p = primaryAction(freshnessState(row))
    return (
        <button
            onClick={() => p.kind === 'expand'
                ? onToggleExpand?.(row.dataSourceId)
                : onRefresh(row.dataSourceId, p.scope as RefreshScope,
                    p.firstBuild ? { firstBuild: true } : undefined)}
            disabled={busy}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
            {p.label}
        </button>
    )
})()}
```

Add "Open in Job History" and, when a job is running, "Cancel job" to the overflow items:

```tsx
{job?.id && (
    <DropdownMenu.Item
        onSelect={() => onCancelJob?.(row.dataSourceId, job.id)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.04]"
    >
        <StopCircle className="w-3.5 h-3.5" />
        Cancel job
    </DropdownMenu.Item>
)}
<DropdownMenu.Item asChild
    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.04]"
>
    <Link to={jobHistoryPath({ dataSourceId: row.dataSourceId })}>
        <ArrowUpRight className="w-3.5 h-3.5 text-ink-muted" />
        Open in Job History
    </Link>
</DropdownMenu.Item>
```

Add `StopCircle` to the `lucide-react` import.

**Replace the blanket disable.** Change `const actionsDisabled = busy || running` to `const actionsDisabled = busy` — View progress, Cancel and Open in Job History are precisely the actions that must work *during* a run. Keep the `title` hint only on refresh-scope items.

- [ ] **Step 4: Wire the cancel handler in `index.tsx`**

`index.tsx` has no query client yet, so add one. Imports:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { aggregationService } from '@/services/aggregationService'
import { ACTIVE_JOBS_KEY } from './useActiveJobs'
import { FRESHNESS_KEYS } from './useFreshness'
```

(`FRESHNESS_KEYS` may already be imported from `./useFreshness` — extend that import rather than duplicating it.) Then, inside the component:

```tsx
const qc = useQueryClient()

const onCancelJob = useCallback(async (dsId: string, jobId: string) => {
    await aggregationService.cancelJob(dsId, jobId)
    void qc.invalidateQueries({ queryKey: ACTIVE_JOBS_KEY })
    void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
}, [qc])
```

Pass `onCancelJob={onCancelJob}` to `FreshnessRow`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/admin/Freshness/FreshnessRow.tsx frontend/src/components/admin/Freshness/index.tsx frontend/src/components/admin/Freshness/Freshness.test.tsx
git commit -m "feat: state-driven primary row action with cancel and Job History in the overflow"
```

---

### Task 7: Batch results carry the source name, what happened, and deferral

**Files:**
- Modify: `backend/app/services/aggregation/schemas.py:765-772`
- Modify: `backend/app/services/aggregation/controlplane.py:769-817` and both batch routes
- Test: `backend/tests/test_provider_refresh_batch.py` (append)

**Interfaces:**
- Consumes: `RefreshResponse.actions: List[str]`, `RefreshResponse.deferred: bool`, `RefreshResponse.job_id`.
- Produces: `BatchItemResult` gains `name: Optional[str]` (alias `name`), `actions: List[str]` (default `[]`), `deferred: bool` (default `False`). `_live_ds_rows(session, provider_id=None) -> List[Tuple[str, Optional[str]]]` replaces `_live_ds_ids`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_provider_refresh_batch.py`:

```python
def test_batch_item_reports_name_actions_and_deferral():
    """"Refresh complete" listing opaque ds_ ids tells an operator nothing.
    RefreshResponse already knows what ran and whether the rebuild was
    deferred by cooldown — the batch item must carry both, plus the label,
    or the dialog cannot say what it did."""
    from backend.app.services.aggregation.schemas import BatchItemResult

    item = BatchItemResult(
        dataSourceId="ds_1",
        name="Solidatus Perf Xlarge",
        outcome="done",
        jobId="job_9",
        actions=["content_cleared", "hierarchy_invalidated", "rebuild_queued"],
        deferred=False,
    )
    assert item.name == "Solidatus Perf Xlarge"
    assert "rebuild_queued" in item.actions
    assert item.deferred is False


def test_batch_item_defaults_stay_well_formed_for_the_error_branch():
    """The error path has no RefreshResponse to read, so the new fields must
    default rather than being required — otherwise a failing item raises
    inside the runner and strands the batch at state 'running'."""
    from backend.app.services.aggregation.schemas import BatchItemResult

    item = BatchItemResult(dataSourceId="ds_2", outcome="error")
    assert item.actions == []
    assert item.deferred is False
    assert item.name is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker exec synodic-dev-viz-service-1 sh -lc 'cd /app && PYTHONPATH=/app python -m pytest backend/tests/test_provider_refresh_batch.py -q -k "name_actions or well_formed"'`
Expected: FAIL — `BatchItemResult` has no `name`/`actions`/`deferred`.

- [ ] **Step 3: Extend the schema**

In `backend/app/services/aggregation/schemas.py`, replace the `BatchItemResult` body:

```python
class BatchItemResult(BaseModel):
    """One data source's outcome within a refresh batch.

    ``name``/``actions``/``deferred`` exist so the completion dialog can say
    WHAT it did to each source instead of listing opaque ids with a tick.
    All three default, because the error branch has no ``RefreshResponse``
    to read and an exception there would strand the batch at "running"."""
    data_source_id: str = Field(alias="dataSourceId")
    outcome: Literal["done", "error"]
    job_id: Optional[str] = Field(None, alias="jobId")
    name: Optional[str] = None
    actions: List[str] = Field(default_factory=list)
    deferred: bool = False

    class Config:
        populate_by_name = True
```

- [ ] **Step 4: Thread names and actions through the runner**

In `backend/app/services/aggregation/controlplane.py`:

Rename and widen the enumeration helper (was `_live_ds_ids`):

```python
async def _live_ds_rows(
    session: AsyncSession, *, provider_id: Optional[str] = None,
) -> List[Tuple[str, Optional[str]]]:
    """(id, label) of every live (non-tombstoned) data source — the same
    ``deleted_at IS NULL`` base filter ``assemble_fleet_freshness`` applies
    for the freshness cockpit read. The label rides along so batch results
    can name a source without a second query per item."""
    from backend.app.db.models import WorkspaceDataSourceORM

    q = select(
        WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
    ).where(WorkspaceDataSourceORM.deleted_at.is_(None))
    if provider_id is not None:
        q = q.where(WorkspaceDataSourceORM.provider_id == provider_id)
    rows = await session.execute(q.order_by(WorkspaceDataSourceORM.id))
    return [(r[0], r[1]) for r in rows.all()]
```

Add `Tuple` to the `typing` import at the top of the file if absent.

Change `_run_provider_batch`'s signature from `ds_ids: List[str]` to `ds_rows: List[Tuple[str, Optional[str]]]`, set `"total": len(ds_rows)`, and rewrite `_run_one`:

```python
        async def _run_one(ds_id: str, ds_name: Optional[str]) -> None:
            async with sem:
                try:
                    async with session_factory() as session:
                        resp = await svc.refresh_source(
                            ds_id, session,
                            scope=body.scope, force=body.force,
                            actor=body.actor, origin=body.origin,
                        )
                    item = {
                        "dataSourceId": ds_id, "name": ds_name, "outcome": "done",
                        "jobId": resp.job_id,
                        "actions": list(resp.actions or []),
                        "deferred": bool(resp.deferred),
                    }
                except Exception as exc:
                    logger.warning(
                        "refresh batch %s: item %s failed: %s", batch_id, ds_id, exc,
                    )
                    item = {
                        "dataSourceId": ds_id, "name": ds_name, "outcome": "error",
                        "jobId": None, "actions": [], "deferred": False,
                    }
            await redis.hset(hash_key, f"ds:{ds_id}", _json.dumps(item))
            await redis.hincrby(hash_key, "done", 1)

        await asyncio.gather(*(_run_one(d, n) for d, n in ds_rows))
```

Update `_start_guarded_batch` to take `ds_rows` and use `total=len(ds_rows)`, and update both routes (`controlplane.py:878` and `:908`) to call `_live_ds_rows(...)` and pass the result through. Also update the stale docstring mention at `controlplane.py:723`.

**Two EXISTING tests call this helper directly and will break — they are in a different file, so grepping `controlplane.py` alone will not find them.** In `backend/tests/test_fleet_refresh_batch.py:214-232`, both `test_live_ds_ids_unscoped_has_no_provider_filter_but_excludes_tombstones` and `test_live_ds_ids_scoped_to_one_provider_adds_exactly_one_predicate` call `cp._live_ds_ids(...)` and assert `ids == ["ds-a1", ...]`. Their `_RecordingSession` rows are already 1-tuples (`("ds-a1",)`), so widen them to 2-tuples and update the rename, the assertions and the section header:

```python
# ── Enumeration: `_live_ds_rows` ──────────────────────────────────────


def test_live_ds_rows_unscoped_has_no_provider_filter_but_excludes_tombstones():
    session = _RecordingSession([("ds-a1", "A1"), ("ds-b1", "B1"), ("ds-a2", None)])
    rows = _run(cp._live_ds_rows(session))
    assert rows == [("ds-a1", "A1"), ("ds-b1", "B1"), ("ds-a2", None)]

    sql = _compiled(session.executed[0])
    assert "deleted_at IS NULL" in sql
    assert "provider_id" not in sql  # unscoped: no provider predicate at all


def test_live_ds_rows_scoped_to_one_provider_adds_exactly_one_predicate():
    session = _RecordingSession([("ds-a1", "A1")])
    rows = _run(cp._live_ds_rows(session, provider_id="prov-a"))
    assert rows == [("ds-a1", "A1")]

    sql = _compiled(session.executed[0])
    assert "deleted_at IS NULL" in sql
    assert "provider_id = 'prov-a'" in sql
```

The `("ds-a2", None)` row is deliberate: `label` is a nullable column, so a source with no label must survive enumeration and reach the batch item as `name: None` (where the frontend falls back to the id). Also update the file's module docstring reference at `test_fleet_refresh_batch.py:9`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker exec synodic-dev-viz-service-1 sh -lc 'cd /app && PYTHONPATH=/app python -m pytest backend/tests/test_provider_refresh_batch.py backend/tests/test_fleet_refresh_batch.py backend/tests/test_freshness_endpoints.py -q'`
Expected: PASS — the two new tests plus every pre-existing batch test.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/aggregation/schemas.py backend/app/services/aggregation/controlplane.py backend/tests/test_provider_refresh_batch.py
git commit -m "feat: batch refresh results carry source name, actions and deferral"
```

---

### Task 8: Shared batch results list — names, what happened, links, summary

**Files:**
- Modify: `frontend/src/services/freshnessService.ts:144-148`
- Create: `frontend/src/components/admin/Freshness/BatchResultsList.tsx`
- Modify: `frontend/src/components/admin/Freshness/ProviderRefreshDialog.tsx:164-176`
- Modify: `frontend/src/components/admin/Freshness/FleetRefreshDialog.tsx` (same results list)
- Test: `frontend/src/components/admin/Freshness/BatchResultsList.test.tsx` (create)

**Interfaces:**
- Consumes: `BatchItemResult` (Task 7), `jobHistoryPath` (Task 2).
- Produces: `BatchResultsList({ results }: { results: BatchItemResult[] })`; `describeActions(actions: string[]): string`.

- [ ] **Step 1: Extend the frontend type**

In `frontend/src/services/freshnessService.ts`:

```ts
export interface BatchItemResult {
    dataSourceId: string
    outcome: 'done' | 'error'
    jobId?: string | null
    /** Data source label; absent on older batches still in Redis. */
    name?: string | null
    /** What ran for this source, from the per-source RefreshResponse. */
    actions?: string[]
    /** Cooldown held the rebuild off — "done" but nothing was queued. */
    deferred?: boolean
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/components/admin/Freshness/BatchResultsList.test.tsx`:

```tsx
/**
 * "Refresh complete · 31/31" over a list of ds_ ids tells an operator
 * nothing — least of all that most of those 31 merely QUEUED work that has
 * not started. This list names each source, says what happened, and counts
 * queued separately from finished.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { BatchResultsList, describeActions } from './BatchResultsList'

const results = [
    { dataSourceId: 'ds_1', name: 'Solidatus Perf Xlarge', outcome: 'done' as const,
      jobId: 'job_1', actions: ['content_cleared', 'rebuild_queued'], deferred: false },
    { dataSourceId: 'ds_2', name: 'Nexus Lineage', outcome: 'done' as const,
      jobId: null, actions: ['content_cleared'], deferred: false },
    { dataSourceId: 'ds_3', name: 'Manual Lineage', outcome: 'done' as const,
      jobId: null, actions: [], deferred: true },
    { dataSourceId: 'ds_4', name: null, outcome: 'error' as const, jobId: null },
]

describe('BatchResultsList', () => {
    it('names each source and falls back to the id', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText('Solidatus Perf Xlarge')).toBeInTheDocument()
        expect(screen.getByText('ds_4')).toBeInTheDocument()
    })

    it('counts queued rebuilds separately from finished work', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText(/1 rebuild queued/)).toBeInTheDocument()
        expect(screen.getByText(/1 deferred/)).toBeInTheDocument()
        expect(screen.getByText(/1 failed/)).toBeInTheDocument()
    })

    it('links a queued source to its job', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByRole('link', { name: /View job/ }))
            .toHaveAttribute('href', '/ingestion?tab=jobs&dataSourceId=ds_1')
    })

    it('explains a deferral rather than showing a bare tick', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText(/in cooldown/)).toBeInTheDocument()
    })
})

describe('describeActions', () => {
    it('humanizes known actions', () => {
        expect(describeActions(['content_cleared', 'rebuild_queued'])).toBe('cache cleared · rebuild queued')
    })

    it('passes unknown actions through rather than hiding them', () => {
        expect(describeActions(['warp_drive_engaged'])).toBe('warp drive engaged')
    })

    it('says something for an empty list', () => {
        expect(describeActions([])).toBe('no changes needed')
    })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/BatchResultsList.test.tsx`
Expected: FAIL — cannot resolve `./BatchResultsList`.

- [ ] **Step 4: Implement the component**

Create `frontend/src/components/admin/Freshness/BatchResultsList.tsx`:

```tsx
/**
 * BatchResultsList — the per-source outcome list shared by the provider and
 * fleet refresh dialogs.
 *
 * It exists because "Refresh complete · 31/31" over a list of ds_ ids is not
 * an operator-usable report: it hides what was done, and it reads as "31
 * rebuilds finished" when the truth is "24 rebuilds were QUEUED". One
 * component so the two dialogs cannot drift.
 */
import { Link } from 'react-router-dom'
import { ArrowUpRight, CheckCircle2, Clock, XCircle } from 'lucide-react'
import type { BatchItemResult } from '@/services/freshnessService'
import { jobHistoryPath } from '../job-history/shared'

/** Raw action ids → operator language. Unknown ids are humanized, never
 *  hidden: a silently-dropped action is how a report starts lying. */
const ACTION_COPY: Record<string, string> = {
    // Verified against refresh_source in aggregation/service.py — these are
    // the literal strings it appends, not a paraphrase of them.
    content_cleared: 'cache cleared',
    hierarchy_invalidated: 'cached views invalidated',
    aggregated_lkg_purged: 'fallback snapshot dropped',
    stats_nudged: 'figures refreshed',
    marker_set: 'flagged as changed',
    marker_cleared: 'stale flag cleared',
    invalidated: 'caches invalidated',
    rebuild_queued: 'rebuild queued',
    rebuild_deferred: 'rebuild deferred',
    rebuild_conflict: 'rebuild already running',
    rebuild_error: 'rebuild could not be queued',
}

export function describeActions(actions: string[]): string {
    if (actions.length === 0) return 'no changes needed'
    return actions.map(a => ACTION_COPY[a] ?? a.replace(/_/g, ' ')).join(' · ')
}

export function BatchResultsList({ results }: { results: BatchItemResult[] }) {
    if (results.length === 0) return null

    const queued = results.filter(r => r.outcome === 'done' && r.jobId).length
    const deferred = results.filter(r => r.outcome === 'done' && r.deferred).length
    const failed = results.filter(r => r.outcome === 'error').length

    return (
        <>
            <ul className="max-h-48 overflow-y-auto space-y-1 mb-3">
                {results.map((r) => (
                    <li key={r.dataSourceId} className="flex items-center gap-2 text-xs text-ink-secondary">
                        {r.outcome === 'error'
                            ? <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                            : r.deferred
                                ? <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                        <span className="truncate font-medium text-ink">{r.name || r.dataSourceId}</span>
                        <span className="truncate text-ink-muted">
                            {r.outcome === 'error'
                                ? 'failed to start'
                                : r.deferred
                                    ? 'deferred — in cooldown, no rebuild queued'
                                    : describeActions(r.actions ?? [])}
                        </span>
                        {r.jobId && (
                            <Link
                                to={jobHistoryPath({ dataSourceId: r.dataSourceId })}
                                className="ml-auto inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                            >
                                View job<ArrowUpRight className="w-3 h-3" />
                            </Link>
                        )}
                    </li>
                ))}
            </ul>
            <div className="flex items-center justify-between text-[11px] text-ink-muted mb-4">
                <span>
                    {results.length} source{results.length === 1 ? '' : 's'}
                    {queued > 0 && ` · ${queued} rebuild${queued === 1 ? '' : 's'} queued`}
                    {deferred > 0 && ` · ${deferred} deferred`}
                    {failed > 0 && ` · ${failed} failed`}
                </span>
                {queued > 0 && (
                    <Link
                        to={jobHistoryPath({ status: ['running', 'pending'] })}
                        className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        View all jobs<ArrowUpRight className="w-3 h-3" />
                    </Link>
                )}
            </div>
        </>
    )
}
```

- [ ] **Step 5: Use it in both dialogs**

In `ProviderRefreshDialog.tsx`, replace the `{batch && batch.results.length > 0 && (<ul>…</ul>)}` block (lines 164-176) with:

```tsx
{batch && <BatchResultsList results={batch.results} />}
```

and import it. Both dialogs currently import `{ AlertTriangle, CheckCircle2, Loader2, XCircle, Zap }`; after this task `XCircle` is unused (it moved into `BatchResultsList`), so drop it. Keep `CheckCircle2` — the completion heading still uses it. `AlertTriangle` is dropped in Task 9, not here. Apply the identical replacement to the results list in `FleetRefreshDialog.tsx`.

**An existing test asserts the current heading.** `Freshness.test.tsx:573` has `expect(await screen.findByText('Refresh complete')).toBeInTheDocument()`; update that string to `'Refresh dispatched'`. The same test's mocked batch result is `{ dataSourceId: 'ds-1', outcome: 'done' }` with no `name`/`actions`/`deferred` — it now flows through `BatchResultsList` and must render `ds-1` via the name fallback, `no changes needed` for the empty actions, and a `1 source` summary. That mock is exactly the shape an older batch still sitting in Redis has, so leave it un-widened: it is load-bearing proof the optional fields degrade correctly.

Also change the completion heading so it cannot read as "rebuilds finished":

```tsx
{done ? <><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Refresh dispatched</> : …}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS — 7 new tests plus the existing dialog tests.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/services/freshnessService.ts frontend/src/components/admin/Freshness/BatchResultsList.tsx frontend/src/components/admin/Freshness/BatchResultsList.test.tsx frontend/src/components/admin/Freshness/ProviderRefreshDialog.tsx frontend/src/components/admin/Freshness/FleetRefreshDialog.tsx
git commit -m "feat: batch refresh results name each source and say what happened"
```

---

### Task 9: Impact preview and explicit confirm for rebuilding scopes

**Files:**
- Create: `frontend/src/components/admin/Freshness/RefreshImpact.tsx`
- Modify: `frontend/src/components/admin/Freshness/ProviderRefreshDialog.tsx:120-145`
- Modify: `frontend/src/components/admin/Freshness/FleetRefreshDialog.tsx` (same block)
- Test: `frontend/src/components/admin/Freshness/ProviderRefreshDialog.test.tsx` (append)

**Interfaces:**
- Consumes: `RefreshScope` from `@/services/freshnessService`.
- Produces: `RefreshImpact({ scope, force, sourceCount }: { scope: RefreshScope; force: boolean; sourceCount: number | null })`; `scopeRebuilds(scope: RefreshScope, force: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/admin/Freshness/ProviderRefreshDialog.test.tsx`:

```tsx
describe('refresh impact and confirmation', () => {
    it('knows which scopes rebuild', () => {
        expect(scopeRebuilds('rollups', false)).toBe(true)
        expect(scopeRebuilds('full', false)).toBe(true)
        expect(scopeRebuilds('auto', true)).toBe(true)
        expect(scopeRebuilds('auto', false)).toBe(false)
        expect(scopeRebuilds('read-caches', false)).toBe(false)
        expect(scopeRebuilds('clear', false)).toBe(false)
    })

    it('spells out cache clearing, queued jobs and duration for a full refresh', () => {
        render(<RefreshImpact scope="full" force={false} sourceCount={31} />)
        expect(screen.getByText(/clear cached canvas data/)).toBeInTheDocument()
        expect(screen.getByText(/queue a lineage rebuild job/)).toBeInTheDocument()
        expect(screen.getByText(/minutes to tens of minutes per source/)).toBeInTheDocument()
        expect(screen.getByText(/all 31 live sources/)).toBeInTheDocument()
    })

    it('does not invent a source count before the batch reports one', () => {
        render(<RefreshImpact scope="full" force={false} sourceCount={null} />)
        expect(screen.getByText(/every live source using this provider/)).toBeInTheDocument()
    })

    it('never claims a rebuild for a cache-only scope', () => {
        render(<RefreshImpact scope="read-caches" force={false} sourceCount={31} />)
        expect(screen.queryByText(/rebuild/i)).not.toBeInTheDocument()
    })
})
```

Import `RefreshImpact` and `scopeRebuilds` from `./RefreshImpact` in the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/ProviderRefreshDialog.test.tsx`
Expected: FAIL — cannot resolve `./RefreshImpact`.

- [ ] **Step 3: Implement the impact block**

Create `frontend/src/components/admin/Freshness/RefreshImpact.tsx`:

```tsx
/**
 * RefreshImpact — what the chosen scope will actually do, before it does it.
 *
 * The old copy ("can take several minutes and adds load on the provider")
 * understated a verb that clears cached data and queues an aggregation job
 * for EVERY live source under the provider — on the observed fleet, 31 of
 * them, several of which have previously failed on graph-store memory.
 */
import { AlertTriangle, Clock, Eraser, RotateCcw } from 'lucide-react'
import type { RefreshScope } from '@/services/freshnessService'

/** Scopes that queue aggregation jobs — the expensive, slow, guarded ones. */
export function scopeRebuilds(scope: RefreshScope, force: boolean): boolean {
    return scope === 'rollups' || scope === 'full' || (scope === 'auto' && force)
}

function clearsCache(scope: RefreshScope): boolean {
    return scope === 'full' || scope === 'clear' || scope === 'read-caches'
}

/** The change-gated scope does neither of the above on its own: it checks
 *  each source's fingerprint and acts only where data actually changed.
 *  Without this line the default scope renders a "This will:" header over
 *  an empty list. */
function isChangeGated(scope: RefreshScope, force: boolean): boolean {
    return scope === 'auto' && !force
}

export function RefreshImpact({ scope, force, sourceCount }: {
    scope: RefreshScope
    force: boolean
    /** null until the batch reports its authoritative total — the visible
     *  table may be filtered, so a count derived from it would understate. */
    sourceCount: number | null
}) {
    const rebuilds = scopeRebuilds(scope, force)
    const target = sourceCount == null
        ? 'every live source using this provider'
        : `all ${sourceCount} live sources`

    return (
        <div className="mb-4 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2.5 text-xs text-ink-secondary">
            <p className="mb-2 font-medium text-ink">This will, for {target}:</p>
            <ul className="space-y-1">
                {isChangeGated(scope, force) && (
                    <li className="flex items-start gap-2">
                        <RotateCcw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-500" />
                        check each source and refresh only the ones whose data changed
                        <span className="text-ink-muted">(unchanged sources cost nothing)</span>
                    </li>
                )}
                {clearsCache(scope) && (
                    <li className="flex items-start gap-2">
                        <Eraser className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                        clear cached canvas data <span className="text-ink-muted">(users see slower first loads)</span>
                    </li>
                )}
                {rebuilds && (
                    <>
                        <li className="flex items-start gap-2">
                            <RotateCcw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-500" />
                            queue a lineage rebuild job <span className="text-ink-muted">(run with limited concurrency)</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                            minutes to tens of minutes per source
                        </li>
                    </>
                )}
            </ul>
            {rebuilds && (
                <p className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    Rebuilds continue in the background if you close this.
                </p>
            )}
        </div>
    )
}
```

- [ ] **Step 4: Add the confirm step to both dialogs**

In `ProviderRefreshDialog.tsx`, replace the `{rebuilds && (<div className="…amber…">…</div>)}` block (lines 120-125) with `<RefreshImpact scope={scope} force={force} sourceCount={total > 0 ? total : null} />`, delete the now-unused local `const rebuilds = …` (use `scopeRebuilds(scope, force)` instead), and gate the start button behind a confirmation:

```tsx
const [confirming, setConfirming] = useState(false)
...
<button
    onClick={() => {
        if (scopeRebuilds(scope, force) && !confirming) { setConfirming(true); return }
        start()
    }}
    disabled={refreshProvider.isPending}
    className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
>
    {refreshProvider.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
    {scopeRebuilds(scope, force) && confirming
        ? (total > 0 ? `Yes, rebuild ${total} sources` : 'Yes, rebuild every source')
        : 'Start refresh'}
</button>
```

Reset `confirming` to `false` whenever `scope` or `force` changes, so a scope switch can never inherit a prior confirmation:

```tsx
useEffect(() => { setConfirming(false) }, [scope, force])
```

**`FleetRefreshDialog.tsx` is NOT a copy of its sibling — do not assume symmetry.** Verified differences:

- It offers only **three** scopes (`auto`, `clear`, `full`) at `:102-104`, not five.
- It has **no `force` checkbox** at all — so pass `force={false}` to `RefreshImpact` and to `scopeRebuilds`.
- Its rebuild gate is `const isFull = scope === 'full'` at `:51`, not a `rebuilds` const. Replace it with `scopeRebuilds(scope, false)`, which is exactly equivalent across its three scopes (`full`→true, `auto`/`clear`→false) — verify that equivalence yourself before relying on it.
- Its amber warning block sits at `:125-126`; that is what `RefreshImpact` replaces.
- Its results list is at `:168-170` (replaced in Task 8).

Its confirm copy names the fleet rather than a provider. Everything else — the impact block, the two-step confirm, the reset-on-scope-change effect — is the same. Note its start button is already dynamically labelled `{isFull ? 'Run full refresh' : 'Refresh all sources'}` at `:147`; the confirm step replaces that label only while `confirming` is true.

**An existing test drives this button and will break.** In `Freshness.test.tsx` (the fleet-refresh test ending at `:574`), the flow clicks `advanced options`, then `Full refresh`, then `run full refresh`, and immediately expects `refreshAll` to have been called. With the two-step confirm, that first click only arms the confirmation. Add the second click before the assertion:

```tsx
await user.click(screen.getByRole('button', { name: /run full refresh/i }))
// Full refresh rebuilds every source, so it now takes an explicit confirm.
await user.click(await screen.findByRole('button', { name: /yes, rebuild/i }))

await waitFor(() => expect(refreshAll).toHaveBeenCalledWith(expect.objectContaining({ scope: 'full' })))
```

`ProviderRefreshDialog.test.tsx:49` is NOT affected — it clicks `start refresh` under the default `auto` scope with `force` false, which does not rebuild and so keeps its single click. Verify that stays true rather than assuming it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/admin/Freshness/`
Expected: PASS.

- [ ] **Step 6: Full verification**

```bash
cd frontend && npx vitest run src/components/admin/ && npx tsc --noEmit
```
Expected: all admin suites pass; no new type errors versus baseline.

```bash
docker exec synodic-dev-viz-service-1 sh -lc 'cd /app && PYTHONPATH=/app python -m pytest backend/tests/test_provider_refresh_batch.py backend/tests/test_fleet_refresh_batch.py backend/tests/test_freshness_endpoints.py -q'
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/admin/Freshness/RefreshImpact.tsx frontend/src/components/admin/Freshness/ProviderRefreshDialog.tsx frontend/src/components/admin/Freshness/FleetRefreshDialog.tsx frontend/src/components/admin/Freshness/ProviderRefreshDialog.test.tsx
git commit -m "feat: impact preview and explicit confirm before a provider-wide rebuild"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| §1 polled join, cap, degradation | 3 |
| §1 row badge phase/%/bar | 4 |
| §1 expandable panel + stepper | 5 |
| §1 shared components (move, not copy) | 1 |
| §2 `jobHistoryPath` + five link sites | 2 (helper, drawer), 4 (badge), 6 (overflow), 8 (dialog rows + footer) |
| §3 primary action + overflow, permission model | 6 |
| §4 impact preview + explicit confirm, both dialogs | 9 |
| §5 backend `name`/`actions`/`deferred` | 7 |
| §5 frontend names, actions, summary, links | 8 |
| §6 testing | every task |
