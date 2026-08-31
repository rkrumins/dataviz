/**
 * Freshness cockpit — the tab renders a mocked fleet payload and its row
 * actions fire the unified refresh verb with the right scope. The triage revamp
 * adds: stat-tile status filtering, a URL-synced faceted filter bar, severity
 * ordering, collapsible provider groups, and honest never-built states.
 */
import { useEffect } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { listFleet, refreshSource, getSourceDoc, refreshAll, getBatch, listProviders, listWorkspaces, permissionFn, listJobsGlobal, getReconciliation, getReconciliationActivity, reconcileNow } = vi.hoisted(() => ({
    listFleet: vi.fn(),
    refreshSource: vi.fn(),
    getSourceDoc: vi.fn(),
    refreshAll: vi.fn(),
    getBatch: vi.fn(),
    listProviders: vi.fn(),
    listWorkspaces: vi.fn(),
    permissionFn: vi.fn(),
    listJobsGlobal: vi.fn(),
    getReconciliation: vi.fn(),
    getReconciliationActivity: vi.fn(),
    reconcileNow: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
    usePermissionClaims: () => ({}),
    checkPermission: (_claims: unknown, perm: string, workspaceId?: string | null) =>
        Boolean(permissionFn(perm, workspaceId)),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            listFleet,
            refreshSource,
            getSourceDoc,
            refreshAll,
            getBatch,
            getReconciliation,
            getReconciliationActivity,
            reconcileNow,
        },
    }
})
vi.mock('@/services/providerService', () => ({ providerService: { list: listProviders } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: listWorkspaces } }))
vi.mock('@/services/aggregationService', () => ({ aggregationService: { listJobsGlobal } }))

// jsdom lacks the pointer-capture + scroll APIs Radix calls when a menu opens.
beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
})

import { Freshness } from './index'
import { FreshnessRow, primaryAction, overflowActions } from './FreshnessRow'
import { FreshnessDrawer } from './FreshnessDrawer'
import {
    compareSeverity, freshnessState, isDrifting, isGroupAttention, isPlatformMastered,
    isProjectionStalled, matchesFacet, needsAttention, severityRank,
} from './freshnessTriage'
import type { FreshnessRow as FreshnessRowData } from '@/services/freshnessService'

const recent = new Date(Date.now() - 5 * 60_000).toISOString()

const fleet = {
    total: 2,
    rows: [
        {
            dataSourceId: 'ds-1', workspaceId: 'ws-1', providerId: 'prov-1',
            name: 'Orders Graph', providerName: 'Warehouse',
            aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent,
            generation: 4, staleReason: 'source_changed', drifted: null, runningJobId: null,
            lastEvent: { origin: 'api', outcome: 'accepted', ts: recent },
        },
        {
            dataSourceId: 'ds-2', workspaceId: 'ws-1', providerId: 'prov-1',
            name: 'Customers Graph', providerName: 'Warehouse',
            aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent,
            generation: 2, staleReason: null, drifted: null, runningJobId: null,
            lastEvent: null,
        },
    ],
}

// Mirrors the live URL search string so a test can assert facet→URL sync.
const probe = { search: '' }
function LocationProbe() {
    const { search } = useLocation()
    useEffect(() => { probe.search = search }, [search])
    return null
}

function renderTab(initialEntry = '/?tab=freshness') {
    probe.search = ''
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[initialEntry]}>
                <Freshness />
                <LocationProbe />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('Freshness cockpit', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        listFleet.mockResolvedValue(fleet)
        refreshSource.mockResolvedValue({ scope: 'read-caches', gate: 'n/a', changed: true, actions: [], deferred: false })
        listProviders.mockResolvedValue([{ id: 'prov-1', name: 'Warehouse' }])
        listWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Analytics' }])
        // Default: no active jobs, so unrelated tests see no live-progress badges.
        listJobsGlobal.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
        getReconciliation.mockResolvedValue({
            policy: {
                enabled: true, checkIntervalSecs: 3600,
                envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
                envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700, allDetectors: [],
            },
            runs: [{
                id: 'rcn_1', mode: 'auto', scanned: 12, skipped: 10, seeded: 0,
                findings: 2, actions: 2, errors: 0, byReason: {}, bySkip: {},
                startedAt: recent,
            }],
        })
        getReconciliationActivity.mockResolvedValue({ since: recent, items: [] })
        reconcileNow.mockResolvedValue({ skipped: false, findings: [], run: null })
        // Default: caller can manage sources (rows show actions); not admin.
        permissionFn.mockImplementation((perm: string) => perm === 'workspace:datasource:manage')
    })

    it('renders fleet rows with cache age and an honest Queued badge', async () => {
        renderTab()

        await waitFor(() => {
            expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        })
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()
        expect(screen.getAllByText('Cached').length).toBeGreaterThan(0)
        expect(screen.getAllByText(/updated/i).length).toBeGreaterThan(0)
        // Last activity is a human pill, never raw "api · completed".
        expect(screen.getByText(/Refresh queued/i)).toBeInTheDocument()
        expect(screen.queryByText(/api ·/i)).not.toBeInTheDocument()
        // The source_changed row has a marker but NO running job → "Queued",
        // not "Recomputing" (which now means a job is genuinely in flight).
        expect(screen.getAllByText('Queued').length).toBeGreaterThan(0)
        expect(screen.queryByText('Recomputing')).not.toBeInTheDocument()
        expect(screen.getAllByText('External').length).toBeGreaterThan(0)
        expect(screen.queryByText('Versioned')).not.toBeInTheDocument()
    })

    it('tags a version-controlled source in the Source column', async () => {
        listFleet.mockResolvedValue({
            ...fleet,
            rows: [
                { ...fleet.rows[0], name: 'Versioned Graph', platformMastered: true },
                { ...fleet.rows[1], name: 'External Graph', platformMastered: false },
            ],
        })
        renderTab()
        await waitFor(() => expect(screen.getByText('Versioned Graph')).toBeInTheDocument())
        expect(screen.getByText('Versioned')).toBeInTheDocument()
        expect(screen.getByText('External')).toBeInTheDocument()
    })

    it('fires read-caches immediately from the row action menu', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        // "Refresh caches" is also Customers Graph's primary action (it's
        // upToDate), so scope by role to hit this row's own dropdown item.
        await user.click(screen.getByRole('button', { name: /more actions for orders graph/i }))
        await user.click(await screen.findByRole('menuitem', { name: 'Refresh caches' }))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'read-caches' }))
        })
    })

    it('confirms before a lineage rebuild, then fires the rollups scope', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        // Orders Graph is queued, so the rebuild is its promoted primary
        // action ("Rebuild now") — no need to open the overflow for it.
        await user.click(screen.getByRole('button', { name: 'Rebuild now' }))

        // A confirm dialog gates the rebuild — no mutation yet.
        expect(refreshSource).not.toHaveBeenCalled()
        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: /rebuild lineage/i }))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'rollups' }))
        })
    })

    it('shows the actions menu only for workspaces the caller can manage', async () => {
        // ds-1 is in ws-1 (manageable), ds-2 in ws-2 (not).
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                { ...fleet.rows[0], dataSourceId: 'ds-1', workspaceId: 'ws-1', name: 'Orders Graph' },
                { ...fleet.rows[1], dataSourceId: 'ds-2', workspaceId: 'ws-2', name: 'Customers Graph' },
            ],
        })
        permissionFn.mockImplementation(
            (perm: string, ws?: string) => perm === 'workspace:datasource:manage' && ws === 'ws-1',
        )
        renderTab()

        await waitFor(() => expect(screen.getByText('Customers Graph')).toBeInTheDocument())
        expect(screen.getByRole('button', { name: /more actions for orders graph/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /more actions for customers graph/i })).not.toBeInTheDocument()
    })

    // ── R5.1 — filter bar facets (stat band removed) ─────────────────
    it('filters rows from the status segment on the filter bar', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            ...fleet,
            summary: { total: 2, ready: 2, pending: 0, failed: 0, notBuilt: 0, recomputing: 1, needsAttention: 1, cacheStamped: 2 },
        })
        renderTab('/?tab=freshness')

        const bar = await screen.findByRole('group', { name: /filter by status/i })
        expect(within(bar).getByRole('button', { name: /^Needs attention$/i })).toBeInTheDocument()
        await waitFor(() => {
            expect(screen.getByText(/2\/2 cached/)).toBeInTheDocument()
        })

        // Both rows visible before filtering.
        expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()

        await user.click(within(bar).getByRole('button', { name: /^Needs attention$/i }))
        await waitFor(() => expect(screen.queryByText('Customers Graph')).not.toBeInTheDocument())
        expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        expect(probe.search).toContain('fstatus=needsAttention')

        await user.click(within(bar).getByRole('button', { name: /^All$/i }))
        await waitFor(() => expect(screen.getByText('Customers Graph')).toBeInTheDocument())
        expect(probe.search).not.toContain('fstatus')
    })

    it('toggles the suspended facet from the pulse needs-a-person count', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                { ...fleet.rows[0], driftState: 'suspended', name: 'Held Source' },
                { ...fleet.rows[1], driftState: 'inSync', name: 'Healthy Source' },
            ],
            summary: {
                total: 2, ready: 2, pending: 0, failed: 0, notBuilt: 0,
                recomputing: 0, needsAttention: 1, cacheStamped: 2,
                drifting: 0, suspended: 1,
            },
        })
        renderTab('/?tab=freshness&fstatus=')

        await waitFor(() => expect(screen.getByText('Held Source')).toBeInTheDocument())
        // Pulse count — prefer the aria-pressed control over Start here chips.
        const pulse = screen.getAllByRole('button', { name: /held by the breaker/i })
            .find(el => el.getAttribute('aria-pressed') != null)
        expect(pulse).toBeTruthy()
        await user.click(pulse!)
        await waitFor(() => expect(screen.queryByText('Healthy Source')).not.toBeInTheDocument())
        expect(screen.getByText('Held Source')).toBeInTheDocument()
        expect(probe.search).toContain('fstatus=suspended')
    })

    it('renders a recon fetch error instead of looking healthy', async () => {
        getReconciliation.mockReset()
        getReconciliation.mockRejectedValue(new Error('boom'))
        renderTab()
        expect(await screen.findByText(/could not load overlay integrity/i, {}, { timeout: 4000 }))
            .toBeInTheDocument()
    })

    it('lands on every source instead of auto-filtering to needs-attention', async () => {
        listFleet.mockResolvedValue({
            ...fleet,
            summary: {
                total: 2, ready: 1, pending: 0, failed: 0, notBuilt: 0,
                recomputing: 0, needsAttention: 1, cacheStamped: 2,
            },
        })
        renderTab()
        expect(await screen.findByText('Orders Graph')).toBeInTheDocument()
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()
        expect(probe.search).not.toContain('fstatus=needsAttention')
        expect(probe.search).not.toContain('fstatus=drifting')
    })

    it('names the failure cause on the row and filters related failures', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                {
                    ...fleet.rows[0], name: 'OOM One', aggregationStatus: 'failed',
                    staleReason: null, lastFailureCategory: 'out_of_memory',
                },
                {
                    ...fleet.rows[1], name: 'OOM Two', aggregationStatus: 'failed',
                    staleReason: null, lastFailureCategory: 'out_of_memory',
                },
            ],
            summary: {
                total: 2, ready: 0, pending: 0, failed: 2, notBuilt: 0,
                recomputing: 0, needsAttention: 2, cacheStamped: 2,
            },
        })
        renderTab('/?tab=freshness&fstatus=')
        await waitFor(() => expect(screen.getAllByText('Out of memory').length).toBeGreaterThanOrEqual(2))
        await user.click(screen.getAllByRole('button', { name: /1 more like this/i })[0])
        await waitFor(() => expect(probe.search).toContain('ffail=out_of_memory'))
    })

    it('lets an operator select ready sources and refresh caches in bulk', async () => {
        const user = userEvent.setup()
        renderTab('/?tab=freshness&fstatus=')
        await waitFor(() => expect(screen.getByText('Customers Graph')).toBeInTheDocument())
        await user.click(screen.getByRole('checkbox', { name: 'Select all sources' }))
        expect(await screen.findByText('2 sources selected')).toBeInTheDocument()
        const caches = screen.getAllByRole('button', { name: 'Refresh caches' })
        expect(caches.length).toBeGreaterThan(0)
        expect(screen.getByRole('button', { name: 'Rebuild lineage' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Retry rebuild' })).not.toBeInTheDocument()
        await user.click(caches[caches.length - 1])
        await waitFor(() => expect(refreshSource).toHaveBeenCalled())
        expect(refreshSource.mock.calls.every(([, body]) => body.scope === 'read-caches')).toBe(true)
    })

    // ── R5.2 — severity ordering helper ──────────────────────────────
    it('orders rows by severity, then recency, then name', () => {
        const mk = (p: Partial<FreshnessRowData>): FreshnessRowData =>
            ({ dataSourceId: p.name ?? 'x', name: p.name, ...p } as FreshnessRowData)
        const future = new Date(Date.now() + 60 * 60_000).toISOString()

        const failed = mk({ name: 'failed', aggregationStatus: 'failed' })
        const recomputing = mk({ name: 'recomputing', aggregationStatus: 'ready', staleReason: 'source_changed' })
        const pending = mk({ name: 'pending', aggregationStatus: 'ready', runningJobId: 'job-1' })
        const cooldown = mk({ name: 'cooldown', aggregationStatus: 'ready', cooldownUntil: future })
        const ready = mk({ name: 'ready', aggregationStatus: 'ready' })
        const notBuilt = mk({ name: 'notBuilt', aggregationStatus: null })

        // Drifting outranks recomputing: a recomputing source is already on
        // its way to correct, while a drifting one is serving a picture that
        // no longer matches its data with nothing yet in flight for it.
        const drifting = mk({ name: 'drifting', aggregationStatus: 'ready', driftState: 'overlayMissing' })

        // Rank 1 is now "connections not up to date" — a versioned source
        // serving NO rolled-up connections outranks one serving stale ones,
        // and unlike drifting it will not clear itself. Every band below it
        // shifted down one; the relative order above is unchanged.
        expect([
            severityRank(failed), severityRank(drifting), severityRank(recomputing),
            severityRank(pending), severityRank(cooldown), severityRank(ready),
            severityRank(notBuilt),
        ]).toEqual([0, 2, 3, 4, 5, 6, 7])

        // A version-controlled source is NOT drifting and does not need
        // attention. It is deliberately excluded from every detector because
        // version control maintains its rollups, so surfacing it as a problem
        // would put a permanent false alarm in the cockpit. Mirrors
        // ``_DRIFTING_STATES`` in service.py, which excludes it too.
        const managed = mk({ name: 'managed', aggregationStatus: 'ready', driftState: 'managed' })
        expect(isDrifting(managed)).toBe(false)
        expect(needsAttention(managed)).toBe(false)
        expect(severityRank(managed)).toBe(severityRank(ready))
        expect(isPlatformMastered(managed)).toBe(true)
        expect(isPlatformMastered(mk({ platformMastered: true, driftState: 'inSync' }))).toBe(true)
        expect(isPlatformMastered(mk({ platformMastered: false, driftState: 'managed' }))).toBe(false)

        const suspended = mk({ name: 'suspended', aggregationStatus: 'ready', driftState: 'suspended' })
        expect(needsAttention(suspended)).toBe(true)
        expect(isDrifting(suspended)).toBe(false)

        const shuffled = [ready, notBuilt, failed, cooldown, pending, recomputing, drifting]
        expect(shuffled.slice().sort(compareSeverity).map(r => r.name))
            .toEqual(['failed', 'drifting', 'recomputing', 'pending', 'cooldown', 'ready', 'notBuilt'])

        // Ties in severity break by most-recent aggregation, then name.
        const older = mk({ name: 'aardvark', aggregationStatus: 'ready', lastAggregatedAt: '2020-01-01T00:00:00Z' })
        const newer = mk({ name: 'zulu', aggregationStatus: 'ready', lastAggregatedAt: '2024-01-01T00:00:00Z' })
        expect([older, newer].sort(compareSeverity).map(r => r.name)).toEqual(['zulu', 'aardvark'])
    })

    // ── H3.R1 — honest freshnessState helper ─────────────────────────
    it('derives an honest freshness state from real signals', () => {
        const mk = (p: Partial<FreshnessRowData>): FreshnessRowData =>
            ({ dataSourceId: 'x', ...p } as FreshnessRowData)

        // A failed run wins even when the stale marker is still set — the exact
        // stuck-forever case (marker present, no job, but the rebuild failed).
        expect(freshnessState(mk({ aggregationStatus: 'failed', staleReason: 'source_changed' }))).toBe('failed')
        // A genuinely running job → recomputing (beats the marker).
        expect(freshnessState(mk({ aggregationStatus: 'ready', runningJobId: 'job-1', staleReason: 'source_changed' }))).toBe('recomputing')
        // Marker set, no job, not failed → queued (a deferred rebuild).
        expect(freshnessState(mk({ aggregationStatus: 'ready', staleReason: 'source_changed' }))).toBe('queued')
        // Ready with nothing pending → up to date.
        expect(freshnessState(mk({ aggregationStatus: 'ready' }))).toBe('upToDate')
        // Never aggregated → never built.
        expect(freshnessState(mk({ aggregationStatus: 'none' }))).toBe('neverBuilt')
    })

    // ── H3.R1 — a failed row reads "Rebuild failed", never "Recomputing" ─
    it('renders "Rebuild failed" for a failed source even with the marker set', async () => {
        listFleet.mockResolvedValue({
            total: 1,
            rows: [
                { dataSourceId: 'f1', workspaceId: 'ws-1', providerId: 'prov-1', name: 'Broken Source', providerName: 'Warehouse', aggregationStatus: 'failed', staleReason: 'source_changed', cacheAsOf: recent, lastAggregatedAt: recent, runningJobId: null, lastEvent: null },
            ],
        })
        renderTab()

        await waitFor(() => expect(screen.getByText('Broken Source')).toBeInTheDocument())
        expect(screen.getByText('Rebuild failed')).toBeInTheDocument()
        expect(screen.queryByText('Recomputing')).not.toBeInTheDocument()
        expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    })

    // ── H3.R3 — Clear cache is a first-class, immediate row action ────
    it('fires the clear scope immediately from the row action menu, without a confirm', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        await user.click(screen.getByRole('button', { name: /more actions for orders graph/i }))
        await user.click(await screen.findByText('Clear cache'))

        // No confirm dialog — clear is non-destructive, it runs at once.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'clear' }))
        })
    })

    // ── R5.3 — healthy group collapses to a rollup; attention expands ─
    it('collapses a healthy provider group and expands one with a marker', async () => {
        listFleet.mockResolvedValue({
            total: 3,
            rows: [
                { dataSourceId: 'a1', workspaceId: 'ws-1', providerId: 'p-alpha', name: 'Alpha One', providerName: 'Alpha', aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent, staleReason: null, runningJobId: null, lastEvent: null },
                { dataSourceId: 'a2', workspaceId: 'ws-1', providerId: 'p-alpha', name: 'Alpha Two', providerName: 'Alpha', aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent, staleReason: null, runningJobId: null, lastEvent: null },
                { dataSourceId: 'b1', workspaceId: 'ws-1', providerId: 'p-bravo', name: 'Bravo One', providerName: 'Bravo', aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent, staleReason: 'source_changed', runningJobId: null, lastEvent: null },
            ],
        })
        renderTab()

        // Bravo has a marker → expanded: its row is visible. (Scoped by name to
        // hit the group-header toggle — a row's own primary button can also
        // carry aria-expanded when its state is "recomputing".)
        await waitFor(() => expect(screen.getByText('Bravo One')).toBeInTheDocument())
        expect(screen.getByRole('button', { name: /bravo/i, expanded: true })).toBeInTheDocument()

        // Alpha is healthy → collapsed: rollup line only, no rows.
        const alphaHeader = screen.getByRole('button', { name: /alpha/i, expanded: false })
        expect(alphaHeader).toHaveTextContent('2 ready')
        expect(screen.queryByText('Alpha One')).not.toBeInTheDocument()
    })

    // ── R5.4 — never-built row + Build lineage ───────────────────────
    it('shows a never-built row honestly and builds lineage with the rollups scope', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                // A marked row keeps the provider group expanded so the never-built row renders.
                { dataSourceId: 'att', workspaceId: 'ws-1', providerId: 'prov-1', name: 'Busy Source', providerName: 'Warehouse', aggregationStatus: 'ready', staleReason: 'source_changed', cacheAsOf: recent, lastAggregatedAt: recent, runningJobId: null, lastEvent: null },
                { dataSourceId: 'nb', workspaceId: 'ws-1', providerId: 'prov-1', name: 'Fresh Source', providerName: 'Warehouse', aggregationStatus: 'none', staleReason: null, cacheAsOf: null, lastAggregatedAt: null, runningJobId: null, lastEvent: null },
            ],
        })
        renderTab()

        await waitFor(() => expect(screen.getByText('Fresh Source')).toBeInTheDocument())
        expect(screen.getByText('Never built')).toBeInTheDocument()
        expect(screen.queryByText('Up to date')).not.toBeInTheDocument()

        // Never-built rows promote "Build lineage" straight to the primary
        // button — overflowActions('neverBuilt') is empty, so the dropdown
        // has nothing to offer and isn't part of this flow.
        await user.click(screen.getByRole('button', { name: 'Build lineage' }))

        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: /build lineage/i }))
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('nb', expect.objectContaining({ scope: 'rollups' }))
        })
    })

    // ── R5.5 — URL sync both ways ────────────────────────────────────
    it('writes a provider facet to the URL and pre-applies filters from the URL', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                { dataSourceId: 'ds-1', workspaceId: 'ws-1', providerId: 'prov-1', name: 'Orders Graph', providerName: 'Warehouse', aggregationStatus: 'ready', staleReason: 'source_changed', cacheAsOf: recent, lastAggregatedAt: recent, runningJobId: null, lastEvent: null },
                { dataSourceId: 'ds-2', workspaceId: 'ws-1', providerId: 'prov-2', name: 'Customers Graph', providerName: 'Lakehouse', aggregationStatus: 'ready', staleReason: 'source_changed', cacheAsOf: recent, lastAggregatedAt: recent, runningJobId: null, lastEvent: null },
            ],
        })

        // Part A: selecting a provider facet stamps ?fprov=.
        const { unmount } = renderTab('/?tab=freshness')
        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())
        const trigger = screen.getByRole('button', { name: 'Provider' })
        await user.click(trigger)
        // Scope to the dropdown container so the option (not a group header) is clicked.
        const container = trigger.parentElement as HTMLElement
        await user.click(within(container).getByRole('button', { name: /warehouse/i }))
        await waitFor(() => expect(probe.search).toContain('fprov=prov-1'))
        unmount()

        // Part B: mounting with ?fprov= pre-filters the table.
        renderTab('/?tab=freshness&fprov=prov-2')
        await waitFor(() => expect(screen.getByText('Customers Graph')).toBeInTheDocument())
        expect(screen.queryByText('Orders Graph')).not.toBeInTheDocument()
    })

    // ── G3.R1 — per-provider cache-coverage chip ─────────────────────
    const healthyRow = (over: Partial<FreshnessRowData>): FreshnessRowData => ({
        dataSourceId: 'x', workspaceId: 'ws-1', providerId: 'prov-1', name: 'x',
        providerName: 'Warehouse', aggregationStatus: 'ready', lastAggregatedAt: recent,
        cacheAsOf: recent, staleReason: null, runningJobId: null, lastEvent: null, ...over,
    })

    it('renders the coverage chip from the provider summary and degrades to a client count', async () => {
        // Provider summary present → provider-wide 8/10 (NOT the 2 fetched rows).
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                healthyRow({ dataSourceId: 'ds-1', name: 'Orders Graph' }),
                healthyRow({ dataSourceId: 'ds-2', name: 'Customers Graph' }),
            ],
            summary: { total: 2, ready: 2, pending: 0, failed: 0, notBuilt: 0, recomputing: 0, needsAttention: 0, cacheStamped: 2 },
            providerSummaries: [
                { providerId: 'prov-1', providerName: 'Warehouse', total: 10, ready: 9, pending: 0, failed: 0, notBuilt: 1, needsAttention: 0, cacheStamped: 8 },
            ],
        })
        const { unmount } = renderTab()

        const chip = await screen.findByLabelText(/cache coverage/i)
        // Raw counts are visible, not just in the aria-label.
        expect(chip).toHaveTextContent('8/10 cached')
        expect(chip).toHaveTextContent('80%')
        expect(chip).toHaveAttribute('aria-label', expect.stringContaining('8 of 10'))
        unmount()

        // No providerSummaries (fleet too large) → client count over the rows:
        // one cached (ds-1), one not (ds-2) → 50%.
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                healthyRow({ dataSourceId: 'ds-1', name: 'Orders Graph', cacheAsOf: recent }),
                healthyRow({ dataSourceId: 'ds-2', name: 'Customers Graph', cacheAsOf: null }),
            ],
        })
        renderTab()
        const chip2 = await screen.findByLabelText(/cache coverage/i)
        expect(chip2).toHaveTextContent('1/2 cached')
        expect(chip2).toHaveTextContent('50%')
    })

    it('counts a rebuilding source on its own, not as "attention" (consistent across toggle)', async () => {
        // One rebuilding row (healthy in-progress) + one stale row (attention).
        // isGroupAttention would lump both as attention; the header must use
        // needs-attention (marker-OR-failed) → attention 1, rebuilding 1.
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                healthyRow({ dataSourceId: 'r1', name: 'Rebuilder', runningJobId: 'job-1' }),
                healthyRow({ dataSourceId: 'r2', name: 'Staler', staleReason: 'source_changed' }),
            ],
        })
        renderTab()

        // The group has a marker/rebuild → auto-expands; the strip lives in the
        // toggle button's accessible name.
        const header = await screen.findByRole('button', { name: /warehouse/i, expanded: true })
        expect(header).toHaveTextContent('1 rebuilding')
        expect(header).toHaveTextContent('1 attention')
        expect(header).not.toHaveTextContent('2 attention')
    })

    // ── G3.R2 — drawer "Cache contents" section ──────────────────────
    function renderDrawer() {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return render(
            <QueryClientProvider client={qc}>
                <MemoryRouter>
                    <FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />
                </MemoryRouter>
            </QueryClientProvider>,
        )
    }
    const baseDoc = {
        dataSourceId: 'ds-1', name: 'Orders Graph', providerName: 'Warehouse',
        workspaceId: 'ws-1', aggregationStatus: 'ready', lastAggregatedAt: recent,
        cacheAsOf: recent, generation: 4, events: [],
    }

    it('renders the cache-contents breakdown, and distinguishes unavailable from empty', async () => {
        getSourceDoc.mockResolvedValue({
            ...baseDoc,
            cacheKeyCount: 7,
            cacheKeyCountByEndpoint: { aggregated: 4, 'children-with-edges': 2, 'trace-expand': 1 },
            lkgCount: 3, lkgOldestAgeSecs: 600,
        })
        const { unmount } = renderDrawer()

        expect(await screen.findByText('Cache contents')).toBeInTheDocument()
        expect(screen.getByText('7 entries')).toBeInTheDocument()
        // Friendly endpoint labels (sentence-cased fallback for "trace-expand").
        const agg = screen.getByText('Aggregated lineage').closest('li') as HTMLElement
        expect(within(agg).getByText('4')).toBeInTheDocument()
        expect(screen.getByText('Hierarchy children')).toBeInTheDocument()
        expect(screen.getByText('Trace expand')).toBeInTheDocument()
        // LKG folds into the section.
        expect(screen.getByText('Last known good')).toBeInTheDocument()
        expect(screen.getByText(/3 cached/)).toBeInTheDocument()
        unmount()

        // null → the cache could not be read (unavailable).
        getSourceDoc.mockResolvedValue({ ...baseDoc, cacheKeyCount: null, cacheKeyCountByEndpoint: null })
        const r2 = renderDrawer()
        expect(await screen.findByText(/cache contents unavailable/i)).toBeInTheDocument()
        r2.unmount()

        // 0 / {} → nothing cached yet (distinct from unavailable).
        getSourceDoc.mockResolvedValue({ ...baseDoc, cacheKeyCount: 0, cacheKeyCountByEndpoint: {} })
        renderDrawer()
        expect(await screen.findByText(/nothing cached yet/i)).toBeInTheDocument()
    })

    // ── H3.R2 — drawer resolution guidance for an OOM failure ────────
    const oomDoc = {
        ...baseDoc,
        aggregationStatus: 'failed',
        lastFailureCategory: 'out_of_memory',
        lastFailureReason: 'FalkorDB OutOfMemoryError: used memory > \'maxmemory\'',
        retryCount: 4,
    }

    it('renders OOM resolution guidance with the why/how copy, CTAs, and a retry warning', async () => {
        getSourceDoc.mockResolvedValue(oomDoc)
        renderDrawer()

        // What: honest headline + attempt count.
        expect(await screen.findByText('Lineage rebuild failed')).toBeInTheDocument()
        expect(screen.getByText(/failed after 4 attempts/i)).toBeInTheDocument()
        // Why: the OOM cause in plain language.
        expect(screen.getByText(/ran out of memory/i)).toBeInTheDocument()
        // How: the OOM remediation + a labelled section.
        expect(screen.getByText('How to resolve')).toBeInTheDocument()
        expect(screen.getByText(/free up memory in the graph store/i)).toBeInTheDocument()
        // CTAs: Clear cache (safe) + Retry rebuild, with the retry caution.
        expect(screen.getByRole('button', { name: /clear cache/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /retry rebuild/i })).toBeInTheDocument()
        expect(screen.getByText(/may fail again until memory is freed/i)).toBeInTheDocument()
        // Details: the verbatim error is available for operators.
        expect(screen.getByText(/OutOfMemoryError/)).toBeInTheDocument()
    })

    it('fires the clear scope from the drawer Clear-cache CTA', async () => {
        const user = userEvent.setup()
        getSourceDoc.mockResolvedValue(oomDoc)
        renderDrawer()

        await user.click(await screen.findByRole('button', { name: /clear cache/i }))
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'clear' }))
        })
    })

    it('confirms before the drawer Retry rebuild, then fires the rollups scope', async () => {
        const user = userEvent.setup()
        getSourceDoc.mockResolvedValue(oomDoc)
        renderDrawer()

        await user.click(await screen.findByRole('button', { name: /retry rebuild/i }))
        // A confirm gates the retry (esp. for OOM) — no mutation yet. Scope to
        // the confirm dialog by its message (the drawer is also role=dialog).
        expect(refreshSource).not.toHaveBeenCalled()
        const confirmMsg = await screen.findByText(/retries the aggregated-lineage rebuild/i)
        const dialog = confirmMsg.closest('[role="dialog"]') as HTMLElement
        expect(within(dialog).getByText(/may fail again until memory is freed/i)).toBeInTheDocument()
        await user.click(within(dialog).getByRole('button', { name: /retry rebuild/i }))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'rollups' }))
        })
    })

    it('after Probe drift on an external source, offers Rebuild lineage now', async () => {
        const user = userEvent.setup()
        permissionFn.mockImplementation(
            (perm: string) => perm === 'system:admin' || perm === 'workspace:datasource:manage',
        )
        getSourceDoc.mockImplementation(async (_id: string, probe?: boolean) => ({
            ...baseDoc,
            platformMastered: false,
            drifted: probe ? true : null,
            liveFingerprint: probe ? 'live-fp' : null,
            liveNodeCount: probe ? 99 : null,
            liveEdgeCount: probe ? 40 : null,
        }))
        renderDrawer()

        await user.click(await screen.findByRole('button', { name: /probe now/i }))
        expect(await screen.findByText(/live graph does not match the last aggregation/i)).toBeInTheDocument()
        expect(screen.getByText(/counts were refreshed/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /rebuild lineage now/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /reconcile this source/i })).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /rebuild lineage now/i }))
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'rollups' }))
        })
    })

    it('after Probe drift on a versioned source, points to version control without a reconcile fix', async () => {
        const user = userEvent.setup()
        getSourceDoc.mockImplementation(async (_id: string, probe?: boolean) => ({
            ...baseDoc,
            platformMastered: true,
            drifted: probe ? true : null,
            liveFingerprint: probe ? 'live-fp' : null,
        }))
        renderDrawer()

        await user.click(await screen.findByRole('button', { name: /probe now/i }))
        expect(await screen.findByText(/version control owns the rollups/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /rebuild lineage now/i })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: /open version control/i })).toBeInTheDocument()
    })

    // ── G3.R3 — fleet "Refresh all sources" (admin-gated) ────────────
    it('gates Refresh all sources to system:admin, fires the chosen scope, and stops polling on done', async () => {
        const user = userEvent.setup()

        // Default (manage-only, not admin): the button is absent.
        const { unmount } = renderTab()
        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())
        expect(screen.queryByRole('button', { name: /refresh all sources/i })).not.toBeInTheDocument()
        unmount()

        // Now as a system admin.
        permissionFn.mockImplementation((perm: string) => perm === 'system:admin' || perm === 'workspace:datasource:manage')
        refreshAll.mockResolvedValue({ batchId: 'batch-fleet', providerId: '__fleet__', total: 3, done: 0, results: [], state: 'running' })
        getBatch.mockResolvedValue({
            batchId: 'batch-fleet', providerId: '__fleet__', total: 3, done: 3,
            results: [{ dataSourceId: 'ds-1', outcome: 'done' }], state: 'done',
        })
        renderTab()
        await waitFor(() => expect(screen.getAllByText('Orders Graph').length).toBeGreaterThan(0))

        await user.click(screen.getByRole('button', { name: /refresh all sources/i }))
        // Advanced discloses the scope choice; pick Full refresh.
        await user.click(await screen.findByRole('button', { name: /advanced options/i }))
        await user.click(screen.getByText('Full refresh'))
        await user.click(screen.getByRole('button', { name: /run full refresh/i }))
        // Full refresh rebuilds every source, so it now takes an explicit confirm.
        await user.click(await screen.findByRole('button', { name: /yes, rebuild/i }))

        await waitFor(() => expect(refreshAll).toHaveBeenCalledWith(expect.objectContaining({ scope: 'full' })))
        // Progress polled the batch and rendered completion; the done response
        // stops the poll (no runaway refetch).
        expect(await screen.findByText('Refresh dispatched')).toBeInTheDocument()
        expect(getBatch).toHaveBeenCalledTimes(1)
    })

    // ── Join coverage — index.tsx wires useActiveJobs into each row via
    // activeJobs.byDataSource.get(row.dataSourceId). The rebuild-progress
    // tests below construct the `job` prop by hand directly on FreshnessRow,
    // so this is the only test that exercises the real map lookup.
    it('joins a live job from useActiveJobs onto its row through the real dataSourceId map', async () => {
        // ds-1's job IS in the response (joins). ds-2 is ALSO eligible
        // (runningJobId set → recomputing) but its own job is OMITTED from
        // the response — the fixture used to have only one eligible row, so
        // a mutation that hands the map's only entry to every row (instead
        // of keying by dataSourceId) had nothing to catch it: ds-2 must NOT
        // pick up ds-1's phase/percent.
        listJobsGlobal.mockResolvedValue({
            items: [{
                id: 'job-1', dataSourceId: 'ds-1', status: 'running', triggerSource: 'api',
                currentPhase: 'computing', progress: 62, totalEdges: 10, processedEdges: 6,
                createdEdges: 0, batchSize: 1000, resumable: false, retryCount: 0, createdAt: recent,
            }],
            total: 1, limit: 100, offset: 0,
        })
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                { ...fleet.rows[0], runningJobId: 'job-1' },
                { ...fleet.rows[1], runningJobId: 'job-2' },
            ],
        })
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        const ds1Row = screen.getByText('Orders Graph').closest('tr') as HTMLElement
        expect(within(ds1Row).getByText(/Computing rollups/)).toBeInTheDocument()
        expect(within(ds1Row).getByText(/62%/)).toBeInTheDocument()

        // ds-2 is recomputing but unjoined → a bare "Recomputing" badge,
        // never ds-1's phase or percent.
        const ds2Row = screen.getByText('Customers Graph').closest('tr') as HTMLElement
        expect(within(ds2Row).getByText('Recomputing')).toBeInTheDocument()
        expect(within(ds2Row).queryByText(/Computing rollups/)).not.toBeInTheDocument()
        expect(within(ds2Row).queryByText(/62%/)).not.toBeInTheDocument()
    })
})

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
})

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
        expect(primaryAction('failed')).toMatchObject({ label: 'Retry rebuild', kind: 'refresh', scope: 'rollups' })
        expect(primaryAction('recomputing')).toMatchObject({ label: 'View progress', kind: 'expand' })
        expect(primaryAction('queued')).toMatchObject({ label: 'Rebuild now', kind: 'refresh', scope: 'rollups' })
        expect(primaryAction('stale')).toMatchObject({ label: 'Rebuild now', kind: 'refresh', scope: 'rollups' })
        expect(primaryAction('neverBuilt')).toMatchObject({ label: 'Build lineage', kind: 'refresh', scope: 'rollups', firstBuild: true })
        expect(primaryAction('upToDate')).toMatchObject({ label: 'Refresh caches', kind: 'refresh', scope: 'read-caches' })
    })

    it('never repeats the primary action in the overflow, and offers no rebuild mid-rebuild', () => {
        expect(overflowActions('neverBuilt')).toEqual([])
        expect(overflowActions('recomputing').map(a => a.scope)).toEqual(['read-caches', 'clear'])
        expect(overflowActions('upToDate').map(a => a.scope)).not.toContain('read-caches')
        expect(overflowActions('failed').map(a => a.scope)).not.toContain('rollups')
    })

    // A recomputing row's primaryAction is 'expand', but with no joined job
    // there is no panel to open (403'd jobs query, active-job cap, the two
    // polls not yet converged, ...) — the click must never be dead.
    it('degrades "View progress" to a Job History link when the row cannot expand', () => {
        permissionFn.mockReturnValue(true)
        render(
            <table><tbody>
                <FreshnessRow row={actionRow} colSpan={6} onOpenDrawer={() => {}} onRefresh={() => {}} />
            </tbody></table>,
            { wrapper: MemoryRouter },
        )
        expect(screen.queryByRole('button', { name: 'View progress' })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'View progress' }))
            .toHaveAttribute('href', '/ingestion?tab=jobs&dataSourceId=ds_live')
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

// ── A wedged projection ──────────────────────────────────────────────
//
// The source is mastered here and its last aggregation job succeeded, so
// every pre-existing signal reads healthy. It is not: the projector that
// maintains its rolled-up connections is behind the published head, main
// reads fall back to the version log, and that carries no rollups — so
// aggregated lineage is missing from the canvas right now. A rebuild does
// not fix it, which is why it is its own tier and not "drifting".
describe('a wedged projection across the cockpit', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        listFleet.mockResolvedValue(fleet)
        listProviders.mockResolvedValue([{ id: 'prov-1', name: 'Warehouse' }])
        listWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Analytics' }])
        listJobsGlobal.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
        getReconciliation.mockResolvedValue({
            policy: {
                enabled: true, checkIntervalSecs: 3600,
                envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
                envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700, allDetectors: [],
            },
            runs: [],
        })
        getReconciliationActivity.mockResolvedValue({ since: recent, items: [] })
        permissionFn.mockImplementation((perm: string) => perm === 'workspace:datasource:manage')
    })

    const mk = (p: Partial<FreshnessRowData>): FreshnessRowData =>
        ({ dataSourceId: p.name ?? 'x', name: p.name, ...p } as FreshnessRowData)

    const wedged = mk({
        name: 'wedged', aggregationStatus: 'ready', driftState: 'projectionStalled',
        platformMastered: true, projectorCurrent: false, projectionCommitsBehind: 3,
    })

    it('lands in the attention bucket, not the managed-and-quiet one', () => {
        expect(isProjectionStalled(wedged)).toBe(true)
        expect(needsAttention(wedged)).toBe(true)
        expect(isGroupAttention(wedged)).toBe(true)
        // Its own tier. Folding it into Drifting would point the operator at
        // a rebuild, and a rebuild does not restart a projector.
        expect(isDrifting(wedged)).toBe(false)
        expect(matchesFacet(wedged, 'drifting')).toBe(false)
        expect(matchesFacet(wedged, 'projectionStalled')).toBe(true)
        expect(matchesFacet(wedged, 'needsAttention')).toBe(true)
        // Still mastered here — the moment an operator most needs to know
        // who owns this graph is the moment it stops serving.
        expect(isPlatformMastered(wedged)).toBe(true)
        expect(isPlatformMastered(mk({ driftState: 'projectionStalled' }))).toBe(true)
    })

    it('outranks drifting in the triage queue', () => {
        const drifting = mk({ name: 'drifting', aggregationStatus: 'ready', driftState: 'drifting' })
        const failed = mk({ name: 'failed', aggregationStatus: 'failed' })
        expect(severityRank(wedged)).toBeLessThan(severityRank(drifting))
        expect(severityRank(failed)).toBeLessThan(severityRank(wedged))
        expect([drifting, wedged, failed].sort(compareSeverity).map(r => r.name))
            .toEqual(['failed', 'wedged', 'drifting'])
    })

    it('gets its own tile and facet instead of vanishing from every bucket', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            total: 2,
            rows: [
                {
                    ...fleet.rows[0], name: 'Wedged Source', staleReason: null,
                    driftState: 'projectionStalled', platformMastered: true,
                },
                { ...fleet.rows[1], name: 'Healthy Source', driftState: 'inSync' },
            ],
            summary: {
                total: 2, ready: 2, pending: 0, failed: 0, notBuilt: 0,
                recomputing: 0, needsAttention: 1, cacheStamped: 2,
                drifting: 0, suspended: 0, projectionStalled: 1,
            },
        })
        renderTab('/?tab=freshness&fstatus=')

        // The provider group must force itself open: a wedged source hidden
        // inside a collapsed "healthy" group is the failure this replaces.
        const group = await screen.findByRole('button', { name: /warehouse/i, expanded: true })
        expect(group).toHaveTextContent('1 not serving connections')
        // ...and the briefing at the top names it too, beside "drifting now".
        expect(screen.getAllByRole('button', { name: /1 not serving connections/i }).length)
            .toBeGreaterThan(1)

        await waitFor(() => expect(screen.getByText('Wedged Source')).toBeInTheDocument())
        const tile = screen.getAllByRole('button', { name: /connections not up to date/i })
            .find(el => el.getAttribute('aria-pressed') != null)
        expect(tile).toBeTruthy()
        await user.click(tile!)
        await waitFor(() => expect(screen.queryByText('Healthy Source')).not.toBeInTheDocument())
        expect(screen.getByText('Wedged Source')).toBeInTheDocument()
        expect(probe.search).toContain('fstatus=projectionStalled')
    })

    it('tells the drawer what is wrong and what to do, not "nothing here needs to"', async () => {
        getSourceDoc.mockResolvedValue({
            dataSourceId: 'ds-1', name: 'Orders Graph', workspaceId: 'ws-1',
            aggregationStatus: 'ready', lastAggregatedAt: recent, events: [],
            driftState: 'projectionStalled', platformMastered: true,
            projectorCurrent: false, projectionCommitsBehind: 3,
            projectionLastError: 'verify mismatch at seq 902',
            projectionCheckedAt: recent,
        })
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={qc}>
                <MemoryRouter>
                    <FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />
                </MemoryRouter>
            </QueryClientProvider>,
        )

        expect((await screen.findAllByText('Connections not up to date')).length).toBeGreaterThan(0)
        // The reassurance written for a healthy versioned source is exactly
        // the wrong thing to say here.
        expect(screen.queryByText(/Nothing here needs to/i)).not.toBeInTheDocument()
        // What is wrong, how far behind, and what the operator should do.
        expect(screen.getByText(/3 published changes behind/i)).toBeInTheDocument()
        expect(screen.getByText(/rebuilding this source will not fix it/i)).toBeInTheDocument()
        // The projector's own words, verbatim, as operator detail.
        expect(screen.getByText('verify mismatch at seq 902')).toBeInTheDocument()
    })
})
