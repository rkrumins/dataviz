/**
 * Data → Sources: every source's card carries its open questions, counted once for the workspace's
 * sources, and the chip opens that source's panel on its Questions tab.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { listDataSources: vi.fn().mockResolvedValue([]) },
    resolveSourceMode: () => 'managed',
}))
vi.mock('@/services/aggregationService', () => ({ aggregationService: {} }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { create: vi.fn() } }))
const api = vi.hoisted(() => ({ getSubjectSummaries: vi.fn() }))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))

const WORKSPACE = {
    id: 'ws1', name: 'Sales Analytics', description: '',
    dataSources: [
        { id: 'ds1', label: 'Sales', isPrimary: true, isActive: true, updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'ds2', label: 'Returns', isPrimary: false, isActive: true, updatedAt: '2026-11-01T00:00:00Z' },
    ],
}
vi.mock('@/components/admin/workspace/useWorkspaceDetailData', () => ({
    useWorkspaceDetailData: () => ({
        workspace: WORKSPACE, catalogItems: [], providers: [], ontologies: [], ontologyMap: {},
        dsStatsMap: {}, dsProviderMap: {}, allWorkspaceViews: [], viewTotal: 0, viewCountByDs: {}, readinessMap: {},
        pending: { stats: false, readiness: false, views: false, viewCounts: false },
        healthStatus: 'healthy', aggregateStats: { totalNodes: 0, totalEdges: 0, totalTypes: 0, totalViews: 0 },
        isLoading: false, isRefreshing: false, error: null, reload: vi.fn(),
    }),
}))
vi.mock('@/store/auth', () => ({
    usePermission: () => false,
    usePermissionClaims: () => ({ ws: { ws1: {} } }),
}))
vi.mock('@/store/features', async (orig) => ({
    ...(await orig<typeof import('@/store/features')>()),
    useFeature: () => true,
}))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => true }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
    useDataSourcesWithForks: () => ({ data: undefined }),
    useReviewInboxCounts: () => ({ data: undefined }),
}))
vi.mock('@/components/admin/workspace/overview/WorkspaceOverview', () => ({ WorkspaceOverview: () => null }))
vi.mock('@/components/admin/workspace/DeletedDataSources', () => ({ DeletedDataSources: () => null }))
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({ AddDataSourceWizard: () => null }))
vi.mock('@/features/data-source-transfer/TransferRequestsPanel', () => ({ TransferRequestsPanel: () => null }))
vi.mock('@/components/data-requests/WorkspaceDataRequestsPanel', () => ({ WorkspaceDataRequestsPanel: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceHeroHeader', () => ({ WorkspaceHeroHeader: () => null }))
vi.mock('@/components/admin/workspace/useDataSourceDeletion', () => ({
    useDataSourceDeletion: () => ({ target: null, open: vi.fn(), openPermanent: vi.fn(), close: vi.fn(), confirm: vi.fn() }),
    impactSections: () => [],
    deleteCaveat: () => '',
}))
vi.mock('@/components/admin/workspace/DataSourceDetailPanel', () => ({
    DataSourceDetailPanel: ({ ds, isOpen }: { ds: { label: string } | null; isOpen: boolean }) =>
        ds && isOpen ? <p data-testid="panel">{ds.label}</p> : null,
}))

import { WorkspaceDetailPage } from '../WorkspaceDetailPage'

function Address() {
    const { search } = useLocation()
    return <output data-testid="address">{search}</output>
}

function renderPage(at: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <MemoryRouter initialEntries={[at]}>
            <QueryClientProvider client={qc}>
                <Routes>
                    <Route path="/workspaces/:wsId" element={<><WorkspaceDetailPage /><Address /></>} />
                </Routes>
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    api.getSubjectSummaries.mockReset()
    api.getSubjectSummaries.mockResolvedValue({ summaries: { ds2: { open: 1, answered: 0, total: 1, unread: 1 } } })
})

describe('questions on the data source cards', () => {
    it('counts the sources once and opens one on its Questions tab', async () => {
        renderPage('/workspaces/ws1?tab=data')
        const chip = await screen.findByRole('button', { name: '1 open question, 1 unread' })
        expect(api.getSubjectSummaries).toHaveBeenCalledTimes(1)
        expect(api.getSubjectSummaries).toHaveBeenCalledWith('data_source', ['ds1', 'ds2'])
        fireEvent.click(chip)
        await waitFor(() => expect(screen.getByTestId('panel')).toHaveTextContent('Returns'))
        const address = new URLSearchParams(screen.getByTestId('address').textContent ?? '')
        expect(address.get('ds')).toBe('ds2')
        expect(address.get('dstab')).toBe('questions')
    })

    it('asks nothing away from the sources', async () => {
        renderPage('/workspaces/ws1')
        await new Promise((r) => setTimeout(r, 20))
        expect(api.getSubjectSummaries).not.toHaveBeenCalled()
    })
})
