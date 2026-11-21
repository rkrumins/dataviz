/**
 * The Overview's and a profile's views carry their open questions on cards and rows — counted once
 * for the shelf, opening the questions drawer on that view. A compact tile is one link, so it
 * carries none, and the shelf asks for none.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { View } from '@/services/viewApiService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

vi.mock('@/hooks/useContentInsights', () => ({ useViewUsage: () => ({ data: {} }) }))
vi.mock('@/components/explorer/ExplorerPreviewDrawer', () => ({
    ExplorerPreviewDrawer: ({ view, isOpen }: { view: { name: string } | null; isOpen: boolean }) =>
        isOpen && view ? <div role="dialog" aria-label={`Preview ${view.name}`} /> : null,
}))
const api = vi.hoisted(() => ({ getSubjectSummaries: vi.fn() }))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))

import { OverviewViewGrid } from '../OverviewViewGrid'
import { useDiscussionsDrawer } from '@/features/discussions/drawerStore'

const view = (id: string, name: string) => ({
    id, name, workspaceId: 'ws1', viewType: 'graph', config: {}, visibility: 'workspace', isPinned: false,
    favouriteCount: 0, isFavourited: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u1', tags: [],
}) as unknown as View
const VIEWS = [view('v1', 'Revenue'), view('v2', 'Churn')]

function renderGrid(layout: 'cards' | 'list' | 'compact') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><OverviewViewGrid wsId="ws1" views={VIEWS} layout={layout} /></MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    api.getSubjectSummaries.mockReset()
    api.getSubjectSummaries.mockResolvedValue({ summaries: { v2: { open: 2, answered: 0, total: 2, unread: 0 } } })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
    useDiscussionsDrawer.setState({ target: null })
})

describe('questions on a shelf of views', () => {
    it.each(['cards', 'list'] as const)('counts the shelf once and opens the view’s questions (%s)', async (layout) => {
        renderGrid(layout)
        fireEvent.click(await screen.findByRole('button', { name: '2 open questions' }))
        expect(api.getSubjectSummaries).toHaveBeenCalledTimes(1)
        expect(api.getSubjectSummaries).toHaveBeenCalledWith('view', ['v1', 'v2'])
        expect(useDiscussionsDrawer.getState().target?.subject).toEqual({ type: 'view', id: 'v2', name: 'Churn' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('asks nothing for compact tiles', async () => {
        renderGrid('compact')
        await screen.findByText('Churn')
        await new Promise((r) => setTimeout(r, 20))
        expect(api.getSubjectSummaries).not.toHaveBeenCalled()
    })
})
