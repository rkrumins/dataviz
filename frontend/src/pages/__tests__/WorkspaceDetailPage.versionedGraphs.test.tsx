/**
 * The workspace page's Versioned graphs tab: offered while version control is on, it holds the
 * workspace's defaults, its graphs and their history (WorkspaceVersionedGraphs has its own spec).
 * Changes staged there survive a look at another tab, whose button says how many. The drafts and
 * reviews policy moved there: Data Sources no longer carries it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDetailPage } from '../WorkspaceDetailPage'

let versioningOn = true

vi.mock('@/services/workspaceService', () => ({ workspaceService: { listDataSources: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/aggregationService', () => ({ aggregationService: {} }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { create: vi.fn() } }))

const WORKSPACE = {
    id: 'ws1', name: 'Sales Analytics', description: '',
    dataSources: [{ id: 'ds1', label: 'Sales', isPrimary: true, isActive: true, ontologyId: 'o1' }],
}

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
vi.mock('@/store/features', () => ({ useFeature: (key: string) => (key === 'versioningEnabled' ? versioningOn : true) }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => false }))

vi.mock('@/components/admin/AdminVersionedGraphs/WorkspaceVersionedGraphs', () => ({
    WorkspaceVersionedGraphs: ({ workspaceId, workspaceName, onStagedChange }: {
        workspaceId: string; workspaceName: string; onStagedChange?: (n: number) => void
    }) => (
        <div data-testid="versioned-graphs" data-ws={workspaceId} data-name={workspaceName}>
            <button type="button" onClick={() => onStagedChange?.(2)}>Stage two changes</button>
        </div>
    ),
}))
vi.mock('@/features/reviews/components/WorkspaceReviewsInbox', () => ({ WorkspaceReviewsInbox: () => null }))
vi.mock('@/components/admin/workspace/DeletedDataSources', () => ({ DeletedDataSources: () => null }))
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({ AddDataSourceWizard: () => null }))
vi.mock('@/components/admin/workspace/DataSourceGridCard', () => ({ DataSourceGridCard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceNodeIdentityDefaults', () => ({ WorkspaceNodeIdentityDefaults: () => null }))
vi.mock('@/components/admin/workspace/DraftsWhoseOwnerLeft', () => ({ DraftsWhoseOwnerLeft: () => <div data-testid="drafts-owner-left" /> }))
vi.mock('@/components/admin/workspace/WorkspaceViewsSection', () => ({ default: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceAggregationDashboard', () => ({ WorkspaceAggregationDashboard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceOntologyTimeline', () => ({ WorkspaceOntologyTimeline: () => null }))
vi.mock('@/components/workspaces/WorkspaceMembers', () => ({ WorkspaceMembers: () => null }))
vi.mock('@/components/activity/ActivityExplorer', () => ({ ActivityExplorer: () => null }))
vi.mock('@/components/ingestion/profiling/ProfilingBoard', () => ({ ProfilingBoard: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceHeroHeader', () => ({ WorkspaceHeroHeader: () => null }))
vi.mock('@/features/data-source-transfer/TransferRequestsPanel', () => ({ TransferRequestsPanel: () => null }))
vi.mock('@/components/admin/workspace/useDataSourceDeletion', () => ({
    useDataSourceDeletion: () => ({ target: null, open: vi.fn(), openPermanent: vi.fn(), close: vi.fn(), confirm: vi.fn() }),
    impactSections: () => [],
    deleteCaveat: () => '',
}))
vi.mock('@/components/admin/workspace/DataSourceDetailPanel', () => ({ DataSourceDetailPanel: () => null }))

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

beforeEach(() => { versioningOn = true })

describe('the workspace page’s Versioned graphs tab', () => {
    it('opens on the workspace’s defaults, its graphs and their history', async () => {
        renderPage('/workspaces/ws1?tab=versioned-graphs')
        const tab = await screen.findByTestId('versioned-graphs')
        expect(tab).toHaveAttribute('data-ws', 'ws1')
        expect(tab).toHaveAttribute('data-name', 'Sales Analytics')
    })

    it('is offered only while version control is on', () => {
        renderPage('/workspaces/ws1').unmount()
        versioningOn = false
        renderPage('/workspaces/ws1?tab=versioned-graphs')
        expect(screen.queryByRole('button', { name: /Versioned graphs/ })).not.toBeInTheDocument()
        expect(screen.queryByTestId('versioned-graphs')).not.toBeInTheDocument()
    })

    it('keeps what is staged there while another tab is open, and says how much on its button', async () => {
        renderPage('/workspaces/ws1?tab=versioned-graphs')
        fireEvent.click(await screen.findByRole('button', { name: 'Stage two changes' }))
        fireEvent.click(screen.getByRole('button', { name: /Data Sources/ }))
        // Hidden, not gone: the staged changes are still there when it opens again.
        expect(screen.getByTestId('versioned-graphs').parentElement).not.toBeVisible()
        expect(screen.getByRole('button', { name: /Versioned graphs/ })).toHaveTextContent('2 not saved')
        fireEvent.click(screen.getByRole('button', { name: /Versioned graphs/ }))
        expect(screen.getByTestId('versioned-graphs')).toBeVisible()
    })

    it('keeps the drafts whose owner left on Data Sources', () => {
        renderPage('/workspaces/ws1')
        expect(screen.getByTestId('drafts-owner-left')).toBeInTheDocument()
    })
})
