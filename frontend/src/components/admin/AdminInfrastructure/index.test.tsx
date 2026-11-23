/**
 * Admin → Infrastructure is health only. It says what versioned graphs are set to, each category in
 * the server's words and linked to itself in Admin → Versioned graphs, and changes none of it: no
 * settings card, no graph list, no input of any kind. Links to what it used to open keep working:
 * `?graphs` goes to Admin → Versioned graphs, `?limits=` to the node's limits on Admin → Graph store.
 * Labels come from the registry's catalogue, as the server serves it.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { CATALOGUE } from '@/components/settings'
import { OPERATOR_SCHEMA } from '@/components/admin/AdminVersionedGraphs/__fixtures__/api'
import { calls, json, mockApi, renderWithApi, type Sent } from '@/components/admin/AdminVersionedGraphs/__tests__/helpers'
import type { SystemStatusSnapshot } from '@/services/systemStatusService'
import { AdminInfrastructure } from '.'

const PAGE = { path: '/admin/infrastructure', route: '/admin/infrastructure' }

const SNAPSHOT: SystemStatusSnapshot = {
    status: 'healthy', generatedAt: '2026-11-17T09:00:00Z', cacheAgeMs: 1200,
    overview: { workspaces: 3, dataSources: 12, providers: { total: 1, active: 1 }, versionedGraphs: 42, orphanedGraphs: 0, openReviews: 2, commits: 1234 },
    services: [
        { key: 'mgmtPostgres', label: 'Postgres · Management', status: 'healthy', latencyMs: 2, error: null, detail: {} },
        {
            key: 'falkordb', label: 'FalkorDB', status: 'healthy', latencyMs: 2, error: null,
            detail: { mode: 'standalone', endpoint: 'falkordb:6379', graphCount: 4, usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7 },
        },
    ],
    graphProviders: [{ id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true, versionedGraphs: 42, versionedBytes: 26_214_400 }],
    streams: null,
    projection: { totalGraphs: 42, fresh: 41, lagging: 1, projecting: 0, rebuilding: 0, evicted: 0, failed: 0, maxLag: 2, worst: [] },
    aggregationJobs: { total: 120, byStatus: { completed: 118, failed: 2 }, successRate: 98, avgDurationSeconds: 42, stuckJobs: 0 },
    bootstrapJobs: null,
    statsPolling: { byStatus: {}, overdue: 0, recentErrors: [] },
    reconciliation: { enabled: true, intervalSecs: 300, lastStartedAt: null, stopped: false, notYetRun: false, suspendedCount: 0 },
    outbox: { pending: 0, oldestPendingAgeS: null, relayAlive: true },
}

/** The capacity sweep's reading of the same node, so its limits can be adjusted. */
const CAPACITY = {
    limits: {
        shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
        maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
    },
    shards: [{
        endpoint: 'falkordb:6379', used: 5_368_709_120, maxmemory: 12_884_901_888, policy: 'noeviction', measurable: true,
        usedPct: 41.7, reservePct: 20, reserveBytes: 2_576_980_377, availableBytes: 4_939_212_391,
        allowedGrowthEdges: 9_646_899, governedBy: 'shard', staticCap: 25_000_000, sources: [],
        queryMemCapacity: 536_870_912, timeoutMaxMs: 180_000, threadCount: 4,
    }],
    unresolved: [], sourcesTotal: 1, truncated: false, measuredAt: '2026-11-17T09:00:00Z', cacheAgeMs: 0,
}

/** The settings API from the section's harness, and this page's own snapshot and capacity. */
function api(answer: (req: Sent) => Response | undefined = () => undefined): Sent[] {
    return mockApi('ok', (req) => answer(req)
        ?? (req.path.endsWith('/admin/system/status') ? json(SNAPSHOT)
            : req.path.endsWith('/admin/aggregation/capacity') ? json(CAPACITY) : undefined))
}

const where = () => screen.getAllByTestId('where').at(-1)!

beforeEach(() => {
    useAuthStore.setState({ permissions: { sid: 't', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, residencyEnabled: true, candidateKeysEnabled: false } } as never)
})

describe('Admin → Infrastructure', () => {
    it('says what each category of versioned-graph settings is set to, and links to it', async () => {
        api()
        renderWithApi(<AdminInfrastructure />, PAGE)
        const panel = within(await screen.findByRole('region', { name: 'Versioned graph settings' }))
        const categories = [...OPERATOR_SCHEMA.categories].sort((a, b) => a.order - b.order)
        expect(categories.map((c) => c.id)).toEqual([...CATALOGUE.categories].sort((a, b) => a.order - b.order).map((c) => c.id))
        for (const c of categories) {
            expect(await panel.findByRole('link', { name: c.label })).toHaveAttribute('href', `/admin/versioned-graphs?tab=settings#category-${c.id}`)
            expect(panel.getByText(c.posture)).toBeInTheDocument()
        }
        // A category's switch, where it has one: the posture says what it does once on.
        expect(panel.getByText('New-version builds: off')).toBeInTheDocument()
        expect(panel.getByText('Graph residency: on')).toBeInTheDocument()
        expect(panel.getByRole('link', { name: 'Open the settings' })).toHaveAttribute('href', '/admin/versioned-graphs?tab=settings')
        expect(screen.getByRole('link', { name: 'All versioned graphs' })).toHaveAttribute('href', '/admin/versioned-graphs')
    })

    it('changes nothing about versioned graphs: no settings card, no graph list, no input', async () => {
        api()
        renderWithApi(<AdminInfrastructure />, PAGE)
        await screen.findByRole('region', { name: 'Versioned graph settings' })
        expect(await screen.findByRole('heading', { name: 'Graph data providers' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Versioned graph projection' })).toBeInTheDocument()
        for (const name of ['Residency & eviction', 'Draft retention', 'New-version builds', 'Read mode…', 'Rebuild', 'Move…']) {
            expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
        }
        for (const role of ['textbox', 'combobox', 'spinbutton', 'switch', 'radio', 'checkbox', 'slider'] as const) {
            expect(screen.queryAllByRole(role)).toEqual([])
        }
    })

    it('adjusts a node’s limits on Admin → Graph store', async () => {
        api()
        renderWithApi(<AdminInfrastructure />, PAGE)
        await userEvent.click(await screen.findByRole('button', { name: /Adjust graph store limits/ }))
        await waitFor(() => expect(where()).toHaveTextContent(/^\/admin\/graph-store\?limits=falkordb%3A6379$/))
    })

    it('says when the settings couldn’t be read, and still links to them', async () => {
        api((req) => (req.path.endsWith('/settings/versioned-graphs/schema') ? json({ detail: 'The settings store didn’t answer' }, 503) : undefined))
        renderWithApi(<AdminInfrastructure />, PAGE)
        const panel = within(await screen.findByRole('region', { name: 'Versioned graph settings' }))
        expect(await panel.findByText('Couldn’t read the settings: The settings store didn’t answer', {}, { timeout: 4000 })).toBeInTheDocument()
        expect(panel.getByRole('link', { name: 'Open the settings' })).toBeInTheDocument()
    })

    it('shows the settings and their links to system admins only', async () => {
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: {} }, permissionsStatus: 'ready' } as never)
        const sent = api()
        renderWithApi(<AdminInfrastructure />, PAGE)
        expect(await screen.findByRole('heading', { name: 'Versioned graph projection' })).toBeInTheDocument()
        expect(screen.queryByRole('region', { name: 'Versioned graph settings' })).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'All versioned graphs' })).not.toBeInTheDocument()
        expect(calls(sent, 'GET', '/settings/versioned-graphs/schema')).toEqual([])
    })
})

describe('links to what Infrastructure used to open', () => {
    it('takes the list of versioned graphs (?graphs) to Admin → Versioned graphs', async () => {
        const sent = api()
        renderWithApi(<AdminInfrastructure />, { ...PAGE, path: '/admin/infrastructure?graphs' })
        await waitFor(() => expect(where()).toHaveTextContent(/^\/admin\/versioned-graphs$/))
        expect(calls(sent, 'GET', '/admin/system/status')).toEqual([])
    })

    it('takes a node’s limits (?limits=) to Admin → Graph store, the dialog open', async () => {
        api()
        renderWithApi(<AdminInfrastructure />, { ...PAGE, path: '/admin/infrastructure?limits=10.0.0.1%3A6379' })
        await waitFor(() => expect(where()).toHaveTextContent(/^\/admin\/graph-store\?limits=10\.0\.0\.1%3A6379$/))
    })
})
