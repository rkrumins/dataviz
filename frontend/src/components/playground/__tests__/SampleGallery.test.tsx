/**
 * Start from a sample: each sample is a card saying what it is, how big and how it opens;
 * one click makes it — the card says so while it does — and opens its Context View, with a
 * way into the canvas tour (while tours are on) and to the example change waiting for review;
 * once the reader has used all their graphs, the cards say what to do instead; and nothing is
 * offered while blank graphs are off.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundSamples } from '@/services/playgroundService'

const { samples, startSample, notify, loadWorkspaces } = vi.hoisted(() => ({
    samples: vi.fn(),
    startSample: vi.fn(),
    notify: vi.fn(),
    loadWorkspaces: vi.fn(),
}))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { samples, startSample } }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { SampleGallery } from '../SampleGallery'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useWorkspacesStore } from '@/store/workspaces'

const CATALOGUE: PlaygroundSamples = {
    quotaLeft: 2,
    samples: [
        {
            id: 'retail-pipeline', title: 'Retail data pipeline', description: 'Follow sales to the dashboards.',
            icon: 'ShoppingCart', color: 'amber', viewType: 'graph', nodeCount: 46, edgeCount: 58,
            entityTypes: ['Source system', 'Dashboard'],
        },
        {
            id: 'customer-360', title: 'Customer 360', description: 'One view of each customer.',
            icon: 'Users', color: 'sky', viewType: 'graph', nodeCount: 36, edgeCount: 50,
            entityTypes: ['Business system', 'Report'],
        },
    ],
}

function ViewPage() {
    return <p>view {useParams().viewId}{useLocation().search}</p>
}
function ReviewPage() {
    const { wsId, prId } = useParams()
    return <p>review {prId} in {wsId}</p>
}
/** The actions the success notification offered. */
const offered = () => (notify.mock.calls.find(c => c[0] === 'success')?.[2] ?? []) as { label: string; onClick: () => void }[]

function renderGallery() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/workspaces/ws_play']}>
                <Routes>
                    <Route path="/workspaces/:wsId" element={<SampleGallery workspaceId="ws_play" />} />
                    <Route path="/views/:viewId" element={<ViewPage />} />
                    <Route path="/workspaces/:wsId/reviews/:prId" element={<ReviewPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    samples.mockResolvedValue(CATALOGUE)
    loadWorkspaces.mockResolvedValue(undefined)
    useWorkspacesStore.setState({ loadWorkspaces })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true } })
})

describe('Start from a sample', () => {
    it('shows each sample: what it is, how big, and the view it opens in', async () => {
        renderGallery()
        const list = await screen.findByRole('list', { name: 'Samples' })
        const [retail, c360] = within(list).getAllByRole('listitem')
        expect(retail).toHaveTextContent('Retail data pipeline')
        expect(retail).toHaveTextContent('Follow sales to the dashboards.')
        expect(retail).toHaveTextContent('46 things58 connections2 types')
        expect(retail).toHaveTextContent('Graph view')
        expect(within(retail).getByRole('button', { name: 'Start Retail data pipeline' })).toBeEnabled()
        expect(c360).toHaveTextContent('Customer 360')
    })

    it('makes the sample in one click, says so while it does, and opens its view', async () => {
        let finish: (v: unknown) => void = () => {}
        startSample.mockReturnValue(new Promise(r => { finish = r }))
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Retail data pipeline' }))

        expect(startSample).toHaveBeenCalledWith('retail-pipeline')
        const busy = screen.getByRole('button', { name: 'Starting Retail data pipeline' })
        expect(busy).toHaveTextContent('Starting…')
        expect(busy).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByRole('button', { name: 'Start Customer 360' })).toBeDisabled()   // one at a time

        finish({ dataSourceId: 'ds_new', viewId: 'v_new' })
        expect(await screen.findByText('view v_new')).toBeInTheDocument()
        // An older server's answer: one view, nothing more to offer.
        expect(offered()).toEqual([])
        expect(loadWorkspaces).toHaveBeenCalled()       // the view's page reads its new data source
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('Retail data pipeline'), undefined, undefined)
    })

    it('opens the Context View, and offers the canvas tour and the example review', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, toursEnabled: true } })
        startSample.mockResolvedValue({
            dataSourceId: 'ds_new', viewId: 'v_ctx', viewIds: { context: 'v_ctx', graph: 'v_graph', hierarchy: 'v_tree' },
            draftId: 'br_example', reviewId: 'pr_example',
        })
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Retail data pipeline' }))
        expect(await screen.findByText('view v_ctx')).toBeInTheDocument()
        expect(offered().map(a => a.label)).toEqual(['Take the tour', 'See the example review'])

        act(() => offered()[0].onClick())
        expect(await screen.findByText('view v_ctx?tour=canvas-lineage')).toBeInTheDocument()
        act(() => offered()[1].onClick())
        expect(await screen.findByText('review pr_example in ws_play')).toBeInTheDocument()
    })

    it('without tours, offers only the example — on its draft when there is no review', async () => {
        startSample.mockResolvedValue({
            dataSourceId: 'ds_new', viewId: 'v_ctx', viewIds: { context: 'v_ctx', graph: 'v_graph' }, draftId: 'br_example', reviewId: null,
        })
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Retail data pipeline' }))
        await screen.findByText('view v_ctx')
        expect(offered().map(a => a.label)).toEqual(['See the example review'])
        act(() => offered()[0].onClick())
        expect(await screen.findByText('view v_graph?branch=br_example')).toBeInTheDocument()
    })

    it('says why, and stays put, when the sample can’t be made', async () => {
        startSample.mockRejectedValue(new Error('You have 5 graphs in the Playground, its limit.'))
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Customer 360' }))
        await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'You have 5 graphs in the Playground, its limit.'))
        expect(screen.getByRole('button', { name: 'Start Customer 360' })).toBeEnabled()
        expect(screen.queryByText(/^view /)).toBeNull()
    })

    it('can’t be used once the reader has used all their graphs, and says what to do', async () => {
        samples.mockResolvedValue({ ...CATALOGUE, quotaLeft: 0 })
        renderGallery()
        const retail = await screen.findByRole('button', { name: 'Start Retail data pipeline' })
        expect(retail).toBeDisabled()
        expect(screen.getByText(/delete one you’re done with to start a sample/)).toBeInTheDocument()
        await userEvent.click(retail)
        expect(startSample).not.toHaveBeenCalled()
    })

    it('offers nothing while blank graphs are off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, blankModelsEnabled: false } })
        const { container } = renderGallery()
        await new Promise(r => setTimeout(r, 0))
        expect(samples).not.toHaveBeenCalled()
        expect(container).toBeEmptyDOMElement()
    })
})
