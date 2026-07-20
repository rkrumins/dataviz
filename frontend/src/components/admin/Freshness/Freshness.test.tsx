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

const { listFleet, refreshSource, getSourceDoc, refreshAll, getBatch, listProviders, listWorkspaces, permissionFn } = vi.hoisted(() => ({
    listFleet: vi.fn(),
    refreshSource: vi.fn(),
    getSourceDoc: vi.fn(),
    refreshAll: vi.fn(),
    getBatch: vi.fn(),
    listProviders: vi.fn(),
    listWorkspaces: vi.fn(),
    permissionFn: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
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
        },
    }
})
vi.mock('@/services/providerService', () => ({ providerService: { list: listProviders } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: listWorkspaces } }))

// jsdom lacks the pointer-capture + scroll APIs Radix calls when a menu opens.
beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
})

import { Freshness } from './index'
import { FreshnessDrawer } from './FreshnessDrawer'
import { compareSeverity, freshnessState, severityRank } from './freshnessTriage'
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
        // Default: caller can manage sources (rows show actions); not admin.
        permissionFn.mockImplementation((perm: string) => perm === 'workspace:datasource:manage')
    })

    it('renders fleet rows with cache age and an honest Queued badge', async () => {
        renderTab()

        await waitFor(() => {
            expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        })
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()
        // "as of Xm ago" cache chips are present.
        expect(screen.getAllByText(/as of/i).length).toBeGreaterThan(0)
        // The source_changed row has a marker but NO running job → "Queued",
        // not "Recomputing" (which now means a job is genuinely in flight).
        expect(screen.getByText('Queued')).toBeInTheDocument()
        expect(screen.queryByText('Recomputing')).not.toBeInTheDocument()
    })

    it('fires read-caches immediately from the row action menu', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        await user.click(screen.getByRole('button', { name: /refresh actions for orders graph/i }))
        await user.click(await screen.findByText('Refresh caches'))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'read-caches' }))
        })
    })

    it('confirms before a lineage rebuild, then fires the rollups scope', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        await user.click(screen.getByRole('button', { name: /refresh actions for orders graph/i }))
        await user.click(await screen.findByText('Rebuild lineage'))

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
        expect(screen.getByRole('button', { name: /refresh actions for orders graph/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /refresh actions for customers graph/i })).not.toBeInTheDocument()
    })

    // ── R5.1 — stat band counts + tile filtering ─────────────────────
    it('renders summary counts on the stat band and filters rows by tile', async () => {
        const user = userEvent.setup()
        listFleet.mockResolvedValue({
            ...fleet,
            summary: { total: 2, ready: 2, pending: 0, failed: 0, notBuilt: 0, recomputing: 1, needsAttention: 1, cacheStamped: 2 },
        })
        renderTab()

        const band = await screen.findByRole('group', { name: /fleet summary/i })
        expect(within(band).getByRole('button', { name: /total sources/i })).toHaveTextContent('2')
        expect(within(band).getByRole('button', { name: /needs attention/i })).toHaveTextContent('1')

        // Both rows visible before filtering.
        expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()

        // Clicking the "Needs attention" tile keeps only the stale row.
        await user.click(within(band).getByRole('button', { name: /needs attention/i }))
        await waitFor(() => expect(screen.queryByText('Customers Graph')).not.toBeInTheDocument())
        expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        expect(probe.search).toContain('fstatus=needsAttention')

        // Clicking "Total sources" clears the facet.
        await user.click(within(band).getByRole('button', { name: /total sources/i }))
        await waitFor(() => expect(screen.getByText('Customers Graph')).toBeInTheDocument())
        expect(probe.search).not.toContain('fstatus')
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

        expect([
            severityRank(failed), severityRank(recomputing), severityRank(pending),
            severityRank(cooldown), severityRank(ready), severityRank(notBuilt),
        ]).toEqual([0, 1, 2, 3, 4, 5])

        const shuffled = [ready, notBuilt, failed, cooldown, pending, recomputing]
        expect(shuffled.slice().sort(compareSeverity).map(r => r.name))
            .toEqual(['failed', 'recomputing', 'pending', 'cooldown', 'ready', 'notBuilt'])

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

        await user.click(screen.getByRole('button', { name: /refresh actions for orders graph/i }))
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

        // Bravo has a marker → expanded: its row is visible. (The group-header
        // toggle is the only button carrying aria-expanded.)
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

        await user.click(screen.getByRole('button', { name: /refresh actions for fresh source/i }))
        // Never-built menu offers Build lineage, not Rebuild lineage.
        expect(await screen.findByText('Build lineage')).toBeInTheDocument()
        expect(screen.queryByText('Rebuild lineage')).not.toBeInTheDocument()
        await user.click(screen.getByText('Build lineage'))

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
                <FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />
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

        await waitFor(() => expect(refreshAll).toHaveBeenCalledWith(expect.objectContaining({ scope: 'full' })))
        // Progress polled the batch and rendered completion; the done response
        // stops the poll (no runaway refetch).
        expect(await screen.findByText('Refresh complete')).toBeInTheDocument()
        expect(getBatch).toHaveBeenCalledTimes(1)
    })
})
