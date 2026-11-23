/**
 * Start from a sample: each sample is a card saying what it is, how big and how it opens;
 * Start asks which canvases it opens with — its Context View always, a Graph view and a
 * Hierarchy if chosen, one that can't be had saying why — then makes it, saying so while it
 * does, and opens its Context View, with a way into the canvas tour (while tours are on) and to
 * the example change waiting for review; once the reader has used all their graphs, the cards say
 * what to do instead; and nothing is offered while blank graphs are off.
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
            entityTypes: ['Source system', 'Dashboard'], hierarchy: 'Dashboards and their metrics',
        },
        {
            id: 'customer-360', title: 'Customer 360', description: 'One view of each customer.',
            icon: 'Users', color: 'sky', viewType: 'graph', nodeCount: 36, edgeCount: 50,
            entityTypes: ['Business system', 'Report'], hierarchy: null,
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
/** Open a sample's sheet, choose `canvases` beside its Context View, and start it. */
async function startWith(title: string, canvases: string[] = []) {
    await userEvent.click(await screen.findByRole('button', { name: `Start ${title}` }))
    const sheet = await screen.findByRole('dialog', { name: `Start “${title}”` })
    for (const c of canvases) await userEvent.click(within(sheet).getByRole('checkbox', { name: new RegExp(`^${c}`) }))
    await userEvent.click(within(sheet).getByRole('button', { name: /Start sample/ }))
    return sheet
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

    it('asks which canvases it opens with: the Context View always, the others if chosen', async () => {
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Retail data pipeline' }))
        const sheet = await screen.findByRole('dialog', { name: 'Start “Retail data pipeline”' })
        const context = within(sheet).getByRole('checkbox', { name: 'Context View, opens first' })
        expect(context).toHaveAttribute('aria-checked', 'true')
        expect(context).toHaveAttribute('aria-disabled', 'true')
        const graph = within(sheet).getByRole('checkbox', { name: /^Graph/ })
        const tree = within(sheet).getByRole('checkbox', { name: /^Hierarchy/ })
        expect(graph).toHaveAttribute('aria-checked', 'false')
        expect(tree).toHaveTextContent('Dashboards and their metrics')
        expect(sheet).toHaveTextContent('Just the Context View for now.')
        await userEvent.click(graph)
        expect(graph).toHaveAttribute('aria-checked', 'true')
        expect(sheet).toHaveTextContent('You’ll get 2 views: the Context View, Graph.')

        // Cancelled, nothing is made.
        await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(startSample).not.toHaveBeenCalled()
    })

    it('sends the canvases chosen', async () => {
        startSample.mockResolvedValue({ dataSourceId: 'ds_new', viewId: 'v_ctx' })
        renderGallery()
        await startWith('Retail data pipeline', ['Hierarchy', 'Graph'])
        expect(startSample).toHaveBeenCalledWith('retail-pipeline', ['graph', 'hierarchy'])
    })

    it('says why a sample with nothing nested can’t have a Hierarchy, and never asks for one', async () => {
        startSample.mockResolvedValue({ dataSourceId: 'ds_new', viewId: 'v_ctx' })
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Customer 360' }))
        const sheet = await screen.findByRole('dialog', { name: 'Start “Customer 360”' })
        const tree = within(sheet).getByRole('checkbox', { name: /^Hierarchy/ })
        expect(tree).toHaveAttribute('aria-disabled', 'true')
        expect(tree).toHaveAccessibleDescription(/nothing nested in anything else/)
        await userEvent.click(tree)
        expect(tree).toHaveAttribute('aria-checked', 'false')
        await userEvent.click(within(sheet).getByRole('button', { name: /Start sample/ }))
        expect(startSample).toHaveBeenCalledWith('customer-360', [])
    })

    it('offers no layout an administrator has turned off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, allowedViewModes: ['reference', 'hierarchy'] } })
        renderGallery()
        await userEvent.click(await screen.findByRole('button', { name: 'Start Retail data pipeline' }))
        const graph = within(await screen.findByRole('dialog')).getByRole('checkbox', { name: /^Graph/ })
        expect(graph).toHaveAttribute('aria-disabled', 'true')
        expect(graph).toHaveAccessibleDescription('An administrator has turned Graph views off.')
    })

    it('makes the sample, says so while it does, and opens its view', async () => {
        let finish: (v: unknown) => void = () => {}
        startSample.mockReturnValue(new Promise(r => { finish = r }))
        renderGallery()
        const sheet = await startWith('Retail data pipeline')

        expect(startSample).toHaveBeenCalledWith('retail-pipeline', [])
        const busy = within(sheet).getByRole('button', { name: /Starting…/ })
        expect(busy).toHaveAttribute('aria-busy', 'true')
        expect(busy).toBeDisabled()
        expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeDisabled()   // not while it's made

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
        await startWith('Retail data pipeline', ['Graph', 'Hierarchy'])
        expect(await screen.findByText('view v_ctx')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).toBeNull()
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
        await startWith('Retail data pipeline', ['Graph'])
        await screen.findByText('view v_ctx')
        expect(offered().map(a => a.label)).toEqual(['See the example review'])
        act(() => offered()[0].onClick())
        expect(await screen.findByText('view v_graph?branch=br_example')).toBeInTheDocument()
    })

    it('with no Graph view, finds the example’s draft on the Context View', async () => {
        startSample.mockResolvedValue({
            dataSourceId: 'ds_new', viewId: 'v_ctx', viewIds: { context: 'v_ctx' }, draftId: 'br_example', reviewId: null,
        })
        renderGallery()
        await startWith('Retail data pipeline')
        await screen.findByText('view v_ctx')
        act(() => offered()[0].onClick())
        expect(await screen.findByText('view v_ctx?branch=br_example')).toBeInTheDocument()
    })

    it('says why, and stays put, when the sample can’t be made', async () => {
        startSample.mockRejectedValue(new Error('You have 5 graphs in the Playground, its limit.'))
        renderGallery()
        const sheet = await startWith('Customer 360')
        await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'You have 5 graphs in the Playground, its limit.'))
        expect(within(sheet).getByRole('button', { name: /Start sample/ })).toBeEnabled()     // try again from here
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
