/**
 * The workspace page's tabs: it opens on the Overview; each reader sees only the
 * tabs they can use; and every link written for the old flat tabs still lands —
 * `?tab=aggregation` on Data → Processing, a data source's `?ds=` on Data (and
 * stays there when its panel closes), a tab the reader can't open on the Overview.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDetailPage } from '../WorkspaceDetailPage'

vi.mock('@/services/workspaceService', () => ({ workspaceService: { listDataSources: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/aggregationService', () => ({ aggregationService: {} }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { create: vi.fn() } }))

const WORKSPACE = {
    id: 'ws1', name: 'Sales Analytics', description: '',
    dataSources: [{ id: 'ds1', label: 'Sales', isPrimary: true, isActive: true, ontologyId: 'o1' }],
}
// `loadsLater`: the workspace arrives after the first render, as it does from the server.
const load = vi.hoisted(() => ({ later: false }))
vi.mock('@/components/admin/workspace/useWorkspaceDetailData', async () => {
    const { useEffect, useState } = await vi.importActual<typeof import('react')>('react')
    return { useWorkspaceDetailData: () => {
    const [workspace, setWorkspace] = useState(load.later ? null : WORKSPACE)
    useEffect(() => {
        if (workspace) return
        const t = setTimeout(() => setWorkspace(WORKSPACE), 0)
        return () => clearTimeout(t)
    }, [workspace])
    return {
        workspace, catalogItems: [], providers: [], ontologies: [], ontologyMap: {},
        dsStatsMap: {}, dsProviderMap: {}, allWorkspaceViews: [], viewTotal: 0, viewCountByDs: {}, readinessMap: {},
        pending: { stats: false, readiness: false, views: false, viewCounts: false },
        healthStatus: 'healthy', aggregateStats: { totalNodes: 0, totalEdges: 0, totalTypes: 0, totalViews: 0 },
        isLoading: !workspace, isRefreshing: false, error: null, reload: vi.fn(),
    }
    } }
})

// What this reader may do in the workspace; and each tab's content, as a marker.
const { granted, marker } = vi.hoisted(() => ({
    granted: new Set<string>(),
    marker: (name: string) => () => <div data-testid="content">{name}</div>,
}))
vi.mock('@/store/auth', () => ({
    usePermission: (p: string) => granted.has(p),
    usePermissionClaims: () => ({ ws: { ws1: {} } }),
}))
vi.mock('@/store/features', () => ({ useFeature: () => true }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => true }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
    useDataSourcesWithForks: () => ({ data: undefined }),
    useReviewInboxCounts: () => ({ data: undefined }),
}))

vi.mock('@/components/admin/workspace/overview/WorkspaceOverview', () => ({ WorkspaceOverview: marker('overview') }))
vi.mock('@/components/admin/workspace/WorkspaceSettingsTab', () => ({ WorkspaceSettingsTab: marker('settings') }))
vi.mock('@/components/admin/workspace/WorkspaceViewsSection', () => ({ default: marker('views') }))
vi.mock('@/components/admin/workspace/WorkspaceAggregationDashboard', () => ({ WorkspaceAggregationDashboard: marker('processing') }))
vi.mock('@/components/admin/workspace/WorkspaceOntologyTimeline', () => ({ WorkspaceOntologyTimeline: marker('model') }))
vi.mock('@/components/ingestion/profiling/ProfilingBoard', () => ({ ProfilingBoard: marker('trends') }))
vi.mock('@/features/reviews/components/WorkspaceReviewsInbox', () => ({ WorkspaceReviewsInbox: marker('reviews') }))
vi.mock('@/components/workspaces/WorkspaceMembers', () => ({ WorkspaceMembers: marker('members') }))
vi.mock('@/components/activity/ActivityExplorer', () => ({ ActivityExplorer: marker('activity') }))
vi.mock('@/components/admin/workspace/DataSourceGridCard', () => ({ DataSourceGridCard: marker('sources') }))
vi.mock('@/components/admin/workspace/DeletedDataSources', () => ({ DeletedDataSources: () => null }))
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({ AddDataSourceWizard: () => null }))
vi.mock('@/features/data-source-transfer/TransferRequestsPanel', () => ({ TransferRequestsPanel: () => null }))
vi.mock('@/components/admin/workspace/WorkspaceHeroHeader', () => ({ WorkspaceHeroHeader: () => null }))
vi.mock('@/components/admin/workspace/useDataSourceDeletion', () => ({
    useDataSourceDeletion: () => ({ target: null, open: vi.fn(), openPermanent: vi.fn(), close: vi.fn(), confirm: vi.fn() }),
    impactSections: () => [],
    deleteCaveat: () => '',
}))
vi.mock('@/components/admin/workspace/DataSourceDetailPanel', () => ({
    DataSourceDetailPanel: ({ ds, isOpen, onClose }: { ds: { label: string } | null; isOpen: boolean; onClose: () => void }) =>
        ds && isOpen ? <button onClick={onClose}>close {ds.label}</button> : null,
}))

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

const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent?.replace(/\d+/g, '').trim())

beforeEach(() => { granted.clear(); load.later = false })

describe('the workspace page tabs', () => {
    it('opens on the Overview', () => {
        renderPage('/workspaces/ws1')
        expect(screen.getByTestId('content')).toHaveTextContent('overview')
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('shows a viewer only what a viewer uses', () => {
        renderPage('/workspaces/ws1')
        expect(tabNames()).toEqual(['Overview', 'Views', 'Data', 'Reviews', 'Versioned graphs'])
    })

    it('adds People, Activity, Usage and Settings for a workspace admin', () => {
        for (const p of ['workspace:admin', 'workspace:members:add', 'workspace:datasource:manage']) granted.add(p)
        renderPage('/workspaces/ws1')
        expect(tabNames()).toEqual(['Overview', 'Views', 'Data', 'Reviews', 'Versioned graphs', 'People', 'Activity', 'Usage', 'Settings'])
    })

    it.each([
        ['aggregation', 'processing'],
        ['ontology', 'model'],
        ['profiling', 'trends'],
        ['sources', 'sources'],
    ])('lands an old ?tab=%s link on Data → %s', (tab, content) => {
        renderPage(`/workspaces/ws1?tab=${tab}`)
        expect(screen.getByRole('tab', { name: /Data/ })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByTestId('content')).toHaveTextContent(content)
    })

    it('reads a Data section and moves between them', async () => {
        renderPage('/workspaces/ws1?tab=data&section=model')
        expect(screen.getByTestId('content')).toHaveTextContent('model')
        fireEvent.click(screen.getByRole('radio', { name: /Processing/ }))
        await waitFor(() => expect(screen.getByTestId('content')).toHaveTextContent('processing'))
        expect(screen.getByTestId('address')).toHaveTextContent('tab=data&section=processing')
    })

    it('opens a data source link on Data, and keeps the reader there when its panel closes', async () => {
        renderPage('/workspaces/ws1?ds=ds1')
        expect(screen.getByRole('tab', { name: /Data/ })).toHaveAttribute('aria-selected', 'true')
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('tab=data'))
        fireEvent.click(await screen.findByRole('button', { name: 'close Sales' }))
        await waitFor(() => expect(screen.getByTestId('address')).not.toHaveTextContent('ds='))
        expect(screen.getByRole('tab', { name: /Data/ })).toHaveAttribute('aria-selected', 'true')
    })

    it('keeps a data source link while the workspace is still loading, then opens it', async () => {
        // A notification's link lands on a page that has nothing cached yet.
        load.later = true
        renderPage('/workspaces/ws1?tab=data&section=sources&ds=ds1&dstab=questions')
        expect(await screen.findByRole('button', { name: 'close Sales' })).toBeInTheDocument()
        expect(screen.getByTestId('address')).toHaveTextContent('ds=ds1')
        expect(screen.getByTestId('address')).toHaveTextContent('dstab=questions')
    })

    it('reads a tab the reader cannot open as the Overview', () => {
        renderPage('/workspaces/ws1?tab=members')
        expect(screen.getByTestId('content')).toHaveTextContent('overview')
    })

    it('writes no tab for the Overview', async () => {
        renderPage('/workspaces/ws1?tab=views')
        fireEvent.mouseDown(screen.getByRole('tab', { name: /Overview/ }))
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(/^$/))
    })
})
