/**
 * DataSourceOverviewPage — render smoke test.
 *
 * Verifies the page mounts without throwing and surfaces the key insight
 * the persona came for: the data source name, its metrics, and — the point
 * of the page — WHO uses it (previously only visible in a delete dialog).
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/catalogService', () => ({
    catalogService: {
        get: vi.fn().mockResolvedValue({
            id: 'cat-1', providerId: 'prov-1', sourceIdentifier: 'orders_graph',
            name: 'Orders Graph', status: 'active', permittedWorkspaces: ['*'],
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        }),
        getImpact: vi.fn().mockResolvedValue({
            catalogItems: [],
            workspaces: [{ id: 'ws-1', name: 'Analytics', type: 'workspace' }],
            views: [{ id: 'v-1', name: 'Revenue Lineage', type: 'view' }],
        }),
    },
}))
vi.mock('@/services/providerService', () => ({
    providerService: {
        get: vi.fn().mockResolvedValue({ id: 'prov-1', name: 'Falkor Docker', providerType: 'falkordb' }),
    },
}))
vi.mock('@/hooks/useAssetStats', () => ({
    ASSET_STATS_QUERY_KEY_PREFIX: 'insights-asset-stats',
    useAssetStats: () => ({
        isLoading: false,
        data: {
            data: {
                nodeCount: 67870, edgeCount: 568001,
                entityTypeCounts: { Party: 4000, Account: 3000, Trade: 2000 },
                edgeTypeCounts: { HOLDS: 5000, EXECUTES: 1200 },
            },
            meta: { status: 'fresh', updated_at: new Date().toISOString(), refreshing: false, provider_health: 'ok' },
        },
    }),
}))
vi.mock('@/store/providerHealthModel', () => ({
    useProviderHealth: () => ({ state: 'ready' }),
    PROVIDER_HEALTH_META: { ready: { dot: 'bg-emerald-400', label: 'Healthy' } },
}))
vi.mock('@/components/insights/StatusChip', () => ({
    StatusChip: () => <span data-testid="status-chip" />,
}))

import { DataSourceOverviewPage } from './DataSourceOverviewPage'

function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/datasources/cat-1']}>
                <Routes>
                    <Route path="/datasources/:catalogId" element={<DataSourceOverviewPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('DataSourceOverviewPage', () => {
    it('renders the data source, its metrics, and who uses it', async () => {
        renderPage()

        expect(await screen.findByRole('heading', { name: 'Orders Graph' })).toBeInTheDocument()
        // Metrics rendered (compacted): 67870 → "68k".
        expect(await screen.findByText('68k')).toBeInTheDocument()
        // "Used by" — the consumers, freed from the delete dialog. "Analytics"
        // appears twice (Used-by list + per-workspace Explore-lineage link).
        expect((await screen.findAllByText('Analytics')).length).toBeGreaterThanOrEqual(1)
        expect(await screen.findByText('Revenue Lineage')).toBeInTheDocument()
        // Lineage entry is enabled because a workspace uses it.
        expect(screen.getAllByText('Explore lineage').length).toBeGreaterThan(0)
    })
})
