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
    },
}))
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
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [] }) }))
vi.mock('@/components/views/WorkspaceActivityFeed', () => ({ WorkspaceActivityFeed: () => null }))

import { WorkspaceOverview } from '../WorkspaceOverview'

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
