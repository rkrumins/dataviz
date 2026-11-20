/**
 * The workspace Overview: "Needs your attention" lists only what waits on THIS
 * reader and only what they can act on; the setup checklist ticks from what is
 * really there, offers the next step, and goes once dismissed or done.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'

const { state } = vi.hoisted(() => ({
    state: {
        reviews: { needs_review: 0, sent_back: 0 },
        requests: [] as unknown[],
        transfers: [] as unknown[],
        ownerLeft: [] as unknown[],
        playground: { graphQuota: 3, graphsUsed: 1, sandboxProviderId: 'prov_sb' } as Record<string, unknown> | undefined,
    },
}))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: state.playground }) }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
    useReviewInboxCounts: () => ({ data: { counts: state.reviews } }),
    useDraftsWhoseOwnerLeft: (ws: string | null) => ({ data: ws ? state.ownerLeft : undefined }),
}))
vi.mock('@/hooks/useWorkspaceAccess', () => ({
    useRequestsToAnswer: (_s: string, opts: { enabled: boolean }) => ({ requests: opts.enabled ? state.requests : undefined }),
}))
vi.mock('@/features/data-source-transfer/useDataSourceTransfers', () => ({
    useWorkspaceTransfers: (ws: string | null) => ({ transfers: ws ? state.transfers : undefined }),
}))
vi.mock('@/hooks/useRecentViews', () => ({ useRecentViews: () => ({ recent: [] }) }))
vi.mock('@/hooks/useContentInsights', () => ({ useViewUsage: () => ({ data: {} }) }))
const { listViews, favouriteView } = vi.hoisted(() => ({
    listViews: vi.fn(),
    favouriteView: vi.fn(),
}))
vi.mock('@/services/viewApiService', () => ({ listViews, favouriteView, unfavouriteView: vi.fn() }))
vi.mock('@/components/explorer/ExplorerPreviewDrawer', () => ({
    ExplorerPreviewDrawer: ({ view, isOpen }: { view: { name: string } | null; isOpen: boolean }) =>
        isOpen && view ? <div role="dialog" aria-label={`Preview ${view.name}`} /> : null,
}))
vi.mock('@/components/views/WorkspaceActivityFeed', () => ({ WorkspaceActivityFeed: () => null }))

import { WorkspaceOverview } from '../WorkspaceOverview'
import { useAuthStore } from '@/store/auth'

function ws(over: Partial<WorkspaceResponse> = {}): WorkspaceResponse {
    return {
        id: 'ws1', name: 'Sales', isDefault: false, isActive: true, createdAt: '', updatedAt: '', memberCount: 1,
        dataSources: [],
        ...over,
    } as WorkspaceResponse
}

const onGoTo = vi.fn()
function renderOverview(props: Partial<React.ComponentProps<typeof WorkspaceOverview>> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <WorkspaceOverview
                    workspace={ws()} views={[]} readinessMap={{}}
                    aggregateStats={{ totalNodes: 0, totalEdges: 0, totalTypes: 0, totalViews: 0 }}
                    canManageSources={false} canManageMembers={false} canAddMembers={false}
                    versioningEnabled showActivity={false} onGoTo={onGoTo}
                    {...props}
                />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    onGoTo.mockReset()
    state.reviews = { needs_review: 0, sent_back: 0 }
    state.requests = []
    state.transfers = []
    state.ownerLeft = []
    state.playground = { graphQuota: 3, graphsUsed: 1, sandboxProviderId: 'prov_sb' }
    listViews.mockReset().mockResolvedValue({ items: [] })
    favouriteView.mockReset().mockResolvedValue(undefined)
    window.localStorage.clear()
})

describe('Needs your attention', () => {
    it('says so plainly when nothing waits', () => {
        renderOverview()
        expect(screen.getByText(/all caught up/)).toBeInTheDocument()
    })

    it('lists reviews asking the reader, and goes to Reviews', () => {
        state.reviews = { needs_review: 2, sent_back: 0 }
        renderOverview()
        expect(screen.getByText('2 reviews waiting for you')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Open reviews/ }))
        expect(onGoTo).toHaveBeenCalledWith('reviews')
    })

    it('shows people asking to join only to someone who can let them in', () => {
        state.requests = [{}, {}]
        const { unmount } = renderOverview()
        expect(screen.queryByText(/asking to join/)).toBeNull()
        unmount()
        renderOverview({ canAddMembers: true })
        expect(screen.getByText('2 people asking to join')).toBeInTheDocument()
    })

    it('names a failing source to someone who manages the data, and sends them to Processing', () => {
        const props = {
            workspace: ws({ dataSources: [{ id: 'ds1', label: 'Ledger' }] as never }),
            readinessMap: { ds1: { aggregationStatus: 'failed' } } as never,
        }
        const { unmount } = renderOverview(props)
        expect(screen.queryByText(/needs a look/)).toBeNull()
        unmount()
        renderOverview({ ...props, canManageSources: true })
        expect(screen.getByText('“Ledger” needs a look')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Review/ }))
        expect(onGoTo).toHaveBeenCalledWith('data', 'processing')
    })
})

describe('Get this workspace ready', () => {
    it('is for the people who run the workspace', () => {
        renderOverview()
        expect(screen.queryByText('Get this workspace ready')).toBeNull()
    })

    it('ticks what is really there and offers the next step', () => {
        const onNewView = vi.fn()
        renderOverview({
            canManageSources: true, onNewView,
            workspace: ws({ dataSources: [{ id: 'ds1', label: 'Ledger', ontologyId: 'o1' }] as never }),
            readinessMap: { ds1: { isReady: true, aggregationStatus: 'ready' } } as never,
        })
        expect(screen.getByText(/3 of 5 done/)).toBeInTheDocument()
        expect(screen.getByText('Connect data')).toHaveTextContent('— done')
        const checklist = screen.getByRole('region', { name: 'Get this workspace ready' })
        fireEvent.click(within(checklist).getByRole('button', { name: 'New view' }))
        expect(onNewView).toHaveBeenCalled()
    })

    it('stays hidden once dismissed', () => {
        const { unmount } = renderOverview({ canManageSources: true })
        fireEvent.click(screen.getByRole('button', { name: /Hide the setup checklist/ }))
        expect(screen.queryByText('Get this workspace ready')).toBeNull()
        unmount()
        renderOverview({ canManageSources: true })
        expect(screen.queryByText('Get this workspace ready')).toBeNull()
    })

    it('goes once everything is done', () => {
        renderOverview({
            canManageSources: true,
            workspace: ws({ memberCount: 4, dataSources: [{ id: 'ds1', label: 'Ledger', ontologyId: 'o1' }] as never }),
            readinessMap: { ds1: { isReady: true, aggregationStatus: 'ready' } } as never,
            views: [{ id: 'v1', name: 'Map', isFavourited: false }] as View[],
        })
        expect(screen.queryByText('Get this workspace ready')).toBeNull()
    })
})

describe('In the Playground', () => {
    const playground = (over: Partial<WorkspaceResponse> = {}) => ws({
        id: 'ws_play', name: 'Playground', kind: 'playground',
        dataSources: [
            { id: 'ds_mine', label: 'My experiment', createdBy: 'usr_me' },
            { id: 'ds_theirs', label: 'Their experiment', createdBy: 'usr_other' },
        ] as never,
        ...over,
    })
    beforeEach(() => {
        useAuthStore.setState({ user: { id: 'usr_me' } as never })
    })

    it('leads with the reader’s own experiments, not a setup checklist', () => {
        renderOverview({ workspace: playground(), canManageSources: true, canManageMembers: true })
        const panel = screen.getByRole('region', { name: 'Your experiments' })
        expect(within(panel).getByText('My experiment')).toBeInTheDocument()
        expect(within(panel).queryByText('Their experiment')).toBeNull()
        expect(screen.queryByText('Get this workspace ready')).toBeNull()
    })

    it('shows the quota, and starts a graph on the sandbox provider', () => {
        const onNewGraph = vi.fn()
        renderOverview({ workspace: playground(), onNewGraph })
        expect(screen.getByText('1 of 3 graphs used')).toBeInTheDocument()
        expect(screen.getByRole('meter', { name: 'Graphs used' })).toHaveAttribute('aria-valuenow', '1')
        fireEvent.click(screen.getByRole('button', { name: /Start a new graph/ }))
        expect(onNewGraph).toHaveBeenCalledWith('prov_sb')
    })

    it('stops new graphs at the quota, and says what to do', () => {
        state.playground = { graphQuota: 3, graphsUsed: 3, sandboxProviderId: 'prov_sb' }
        const onNewGraph = vi.fn()
        renderOverview({ workspace: playground(), onNewGraph })
        expect(screen.getByRole('button', { name: /Start a new graph/ })).toBeDisabled()
        expect(screen.getByText(/Delete one you’re done with/)).toBeInTheDocument()
    })

    it('shows the first steps before the reader has a graph', () => {
        renderOverview({ workspace: playground({ dataSources: [] }) })
        expect(screen.getByText('Start a blank graph')).toBeInTheDocument()
        expect(screen.queryByText('No views here yet')).toBeNull()
    })

    it('opens one of the reader’s graphs', () => {
        const onOpenGraph = vi.fn()
        renderOverview({ workspace: playground(), onOpenGraph })
        fireEvent.click(screen.getByRole('button', { name: /My experiment/ }))
        expect(onOpenGraph).toHaveBeenCalledWith('ds_mine')
    })
})

describe('Views, shown the way the Explorer shows them', () => {
    const view = (id: string, name: string, over: Partial<View> = {}) => ({
        id, name, viewType: 'graph', workspaceId: 'ws1', workspaceName: 'Sales', dataSourceId: 'ds1', dataSourceName: 'Ledger',
        visibility: 'workspace', isFavourited: false, favouriteCount: 0, tags: [], config: {},
        createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', createdBy: 'usr_ada', createdByName: 'Ada',
        ...over,
    }) as unknown as View

    it('shows the popular views as Explorer cards, which preview on a click', async () => {
        listViews.mockResolvedValue({ items: [view('v1', 'Revenue lineage')] })
        renderOverview({ views: [view('v1', 'Revenue lineage')] })
        const shelf = screen.getByRole('region', { name: 'Popular here' })
        const card = await within(shelf).findByRole('button', { name: /Revenue lineage/ })
        fireEvent.click(card)
        expect(screen.getByRole('dialog', { name: 'Preview Revenue lineage' })).toBeInTheDocument()
    })

    it('favourites a view from its card, at once', async () => {
        listViews.mockResolvedValue({ items: [view('v1', 'Revenue lineage')] })
        renderOverview({ views: [view('v1', 'Revenue lineage')] })
        const shelf = screen.getByRole('region', { name: 'Popular here' })
        await within(shelf).findByRole('button', { name: /Revenue lineage/ })
        const heart = within(shelf).getByTitle('Favorite')
        fireEvent.click(heart)
        expect(favouriteView).toHaveBeenCalledWith('v1')
        expect(within(shelf).getByTitle('Unfavorite')).toHaveAttribute('aria-pressed', 'true')
    })
})
