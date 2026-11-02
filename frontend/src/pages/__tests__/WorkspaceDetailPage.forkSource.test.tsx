/**
 * A fork's data source opens on the workspace page like any other: `?ds=<its dsfork_ id>` — the
 * route a fork's Open, its parent link and Admin's Open source take. The workspace's own list leaves
 * forks out, so the page reads the list that includes them, only when the link names a fork. A fork
 * goes to the trash and moves with the fork, never through the data-source routes: its panel offers
 * neither Delete nor Move.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDetailPage } from '../WorkspaceDetailPage'

const { listDataSources } = vi.hoisted(() => ({ listDataSources: vi.fn() }))

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { listDataSources },
}))
vi.mock('@/services/aggregationService', () => ({ aggregationService: {} }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { create: vi.fn() } }))

const WORKSPACE = {
    id: 'ws1',
    name: 'Sales Analytics',
    description: '',
    dataSources: [
        { id: 'ds1', label: 'Sales', isPrimary: true, isActive: true, ontologyId: 'o1' },
        { id: 'ds2', label: 'Warehouse', isPrimary: false, isActive: true, ontologyId: 'o1' },
    ],
}
const FORK = { id: 'dsfork_1', label: 'Sales · Q3', isPrimary: false, isActive: true, forkOf: { dataSourceId: 'ds1', graphId: 'g1' } }

vi.mock('@/components/admin/workspace/useWorkspaceDetailData', () => ({
    useWorkspaceDetailData: () => ({
        workspace: WORKSPACE, catalogItems: [], providers: [], ontologies: [], ontologyMap: {},
        dsStatsMap: {}, dsProviderMap: {}, viewsByDs: {}, allWorkspaceViews: [], readinessMap: {},
        healthStatus: 'healthy', aggregateStats: { totalNodes: 0, totalEdges: 0, totalTypes: 0, totalViews: 0 },
        isLoading: false, isRefreshing: false, error: null, reload: vi.fn(),
    }),
}))
vi.mock('@/store/auth', () => ({
    usePermission: () => true,
    usePermissionClaims: () => ({ ws: { ws1: {} } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => false }))

vi.mock('@/features/reviews/components/WorkspaceReviewsInbox', () => ({ WorkspaceReviewsInbox: () => null }))
vi.mock('@/components/admin/workspace/DeletedDataSources', () => ({ DeletedDataSources: () => null }))
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({ AddDataSourceWizard: () => null }))
vi.mock('@/components/admin/workspace/DataSourceGridCard', () => ({ DataSourceGridCard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceNodeIdentityDefaults', () => ({ WorkspaceNodeIdentityDefaults: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceDraftsPolicy', () => ({ WorkspaceDraftsPolicy: () => null }))
vi.mock('@/components/admin/workspace/DraftsWhoseOwnerLeft', () => ({ DraftsWhoseOwnerLeft: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceViewsSection', () => ({ default: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceAggregationDashboard', () => ({ WorkspaceAggregationDashboard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceOntologyTimeline', () => ({ WorkspaceOntologyTimeline: () => null }))
vi.mock('@/components/workspaces/WorkspaceMembers', () => ({ WorkspaceMembers: () => null }))
vi.mock('@/components/activity/ActivityExplorer', () => ({ ActivityExplorer: () => null }))
vi.mock('@/components/ingestion/profiling/ProfilingBoard', () => ({ ProfilingBoard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceHeroHeader', () => ({ WorkspaceHeroHeader: () => null }))
vi.mock('@/components/admin/workspace/useDataSourceDeletion', () => ({
    useDataSourceDeletion: () => ({ target: null, open: vi.fn(), openPermanent: vi.fn(), close: vi.fn(), confirm: vi.fn() }),
    impactSections: () => [],
    deleteCaveat: () => '',
}))

/** The drawer: which data source it shows, and which of the data-source routes it offers. */
vi.mock('@/components/admin/workspace/DataSourceDetailPanel', () => ({
    DataSourceDetailPanel: ({ ds, isOpen, onDelete, onDeletePermanent, onMove }: {
        ds: { id: string; label: string } | null
        isOpen: boolean
        onDelete?: () => void
        onDeletePermanent?: () => void
        onMove?: () => void
    }) => ds && isOpen ? (
        <div data-testid="panel" data-delete={String(!!onDelete)} data-delete-permanent={String(!!onDeletePermanent)}
            data-move={String(!!onMove)}>{ds.label}</div>
    ) : null,
}))

function renderPage(at: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <MemoryRouter initialEntries={[at]}>
            <QueryClientProvider client={qc}>
                <Routes>
                    <Route path="/workspaces/:wsId" element={<WorkspaceDetailPage />} />
                </Routes>
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    listDataSources.mockReset().mockResolvedValue([...WORKSPACE.dataSources, FORK])
})

describe("a fork's data source on the workspace page", () => {
    it('opens from its link, from the list that includes forks', async () => {
        renderPage('/workspaces/ws1?ds=dsfork_1&dstab=versioning')
        expect(await screen.findByTestId('panel')).toHaveTextContent('Sales · Q3')
        expect(listDataSources).toHaveBeenCalledWith('ws1', { includeForks: true })
    })

    it('offers neither Delete nor Move: a fork goes to the trash and moves with the fork', async () => {
        renderPage('/workspaces/ws1?ds=dsfork_1&dstab=versioning')
        const panel = await screen.findByTestId('panel')
        expect(panel).toHaveAttribute('data-delete', 'false')
        expect(panel).toHaveAttribute('data-delete-permanent', 'false')
        expect(panel).toHaveAttribute('data-move', 'false')
    })

    it('reads nothing more for a data source of the workspace’s own', async () => {
        renderPage('/workspaces/ws1?ds=ds2')
        const panel = await screen.findByTestId('panel')
        expect(panel).toHaveTextContent('Warehouse')
        expect(panel).toHaveAttribute('data-delete', 'true')
        expect(listDataSources).not.toHaveBeenCalled()
    })
})
