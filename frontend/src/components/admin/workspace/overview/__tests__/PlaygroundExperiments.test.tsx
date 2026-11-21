/**
 * The Playground's front page leads with three ways to start, each one a thing to do: a sample
 * (to the samples), your own data (the dialog), or a blank graph (the wizard, on the sandbox) —
 * in place of the steps it used to print. The View wizard's blank path sends people back here
 * with `?start=samples|import`, and they land on what they came for. Once every graph is used,
 * no start is open.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceResponse } from '@/services/workspaceService'

const { get, samples } = vi.hoisted(() => ({ get: vi.fn(), samples: vi.fn() }))
vi.mock('@/services/playgroundService', () => ({
    playgroundService: { get, samples, startSample: vi.fn(), importOwnData: vi.fn() },
}))
// The checklist reads its own signals and has its own suite; here it only has a place.
vi.mock('@/components/playground/BuilderChecklist', () => ({ BuilderChecklist: () => <div data-testid="first-steps" /> }))

import { PlaygroundExperiments } from '../PlaygroundExperiments'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useAuthStore } from '@/store/auth'

const SAMPLES = {
    quotaLeft: 4,
    samples: [{ id: 'retail-pipeline', title: 'Retail data pipeline', description: 'Sales to dashboards.', icon: 'ShoppingCart',
        color: 'amber', viewType: 'graph', nodeCount: 46, edgeCount: 58, entityTypes: [] }],
}

const playground = (dataSources: unknown[] = []) => ({
    id: 'ws_play', name: 'Playground', kind: 'playground', isDefault: false, isActive: true, createdAt: '', updatedAt: '', dataSources,
}) as unknown as WorkspaceResponse

function Address() {
    const { search } = useLocation()
    return <p data-testid="address">{search}</p>
}

const onNewGraph = vi.fn()
function renderPanel({ at = '/workspaces/ws_play', workspace = playground(), canStart = true } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[at]}>
                <PlaygroundExperiments workspace={workspace} views={[]} onNewGraph={canStart ? onNewGraph : undefined} onOpenGraph={vi.fn()} />
                <Address />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const starts = () => screen.getByRole('region', { name: /Start your first graph|Start another graph/ })

beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({ enabled: true, exists: true, joined: true, workspaceId: 'ws_play', graphQuota: 5, graphsUsed: 1, canSetUp: false, sandboxProviderId: 'prov_sb' })
    samples.mockResolvedValue(SAMPLES)
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true } })
    useAuthStore.setState({ user: { id: 'usr_me' } as never })
    Element.prototype.scrollIntoView = vi.fn()
})

describe('Your experiments: three ways to start', () => {
    it('leads a newcomer with three starts, not steps to read', async () => {
        renderPanel()
        const region = await screen.findByRole('region', { name: 'Start your first graph' })
        await waitFor(() => expect(within(region).getAllByRole('button')).toHaveLength(3))
        expect(within(region).getByRole('button', { name: 'Start from a sample' })).toBeEnabled()
        expect(within(region).getByRole('button', { name: 'Bring your own data' })).toBeEnabled()
        expect(within(region).getByRole('button', { name: 'Start a blank graph' })).toBeEnabled()
        expect(region).toHaveTextContent('a graph, a hierarchy or a context view')
        expect(screen.queryByText('Add things and how they connect')).toBeNull()
        expect(screen.getByTestId('first-steps')).toBeInTheDocument()
    })

    it('starts a blank graph on the sandbox', async () => {
        renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: 'Start a blank graph' }))
        await waitFor(() => expect(onNewGraph).toHaveBeenCalledWith('prov_sb'))
    })

    it('takes the reader to the samples, and puts the keyboard there', async () => {
        renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: 'Start from a sample' }))
        const gallery = screen.getByRole('region', { name: 'Start from a sample' })
        expect(gallery.scrollIntoView).toHaveBeenCalled()
        expect(within(gallery).getByRole('heading', { name: 'Start from a sample' })).toHaveFocus()
    })

    it('opens Bring your own data, and closes it again', async () => {
        renderPanel()
        await userEvent.click(await screen.findByRole('button', { name: 'Bring your own data' }))
        const dialog = screen.getByRole('dialog', { name: 'Bring your own data' })
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('offers no own data while blank graphs are off, and nothing to someone who can’t start a graph', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, blankModelsEnabled: false } })
        const { unmount } = renderPanel()
        const region = await screen.findByRole('region', { name: 'Start your first graph' })
        expect(within(region).queryByRole('button', { name: 'Bring your own data' })).toBeNull()
        expect(within(region).queryByRole('button', { name: 'Start from a sample' })).toBeNull()
        unmount()
        renderPanel({ canStart: false })
        expect(screen.queryByRole('region', { name: 'Start your first graph' })).toBeNull()
    })

    it('opens none once every graph is used', async () => {
        get.mockResolvedValue({ enabled: true, exists: true, joined: true, workspaceId: 'ws_play', graphQuota: 2, graphsUsed: 2, canSetUp: false })
        renderPanel()
        await screen.findByText('2 of 2 graphs used')
        for (const b of within(starts()).getAllByRole('button')) expect(b).toBeDisabled()
    })

    it('under the reader’s graphs, offers to start another', async () => {
        renderPanel({ workspace: playground([{ id: 'ds_mine', label: 'Mine', createdBy: 'usr_me' }]) })
        const region = await screen.findByRole('region', { name: 'Start another graph' })
        expect(screen.getByRole('list', { name: 'Your graphs' }).compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})

describe('sent here to start', () => {
    it('?start=import opens Bring your own data, and forgets it', async () => {
        renderPanel({ at: '/workspaces/ws_play?tab=overview&start=import' })
        expect(await screen.findByRole('dialog', { name: 'Bring your own data' })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('?tab=overview'))
    })

    it('?start=samples lands on the samples once they are there', async () => {
        renderPanel({ at: '/workspaces/ws_play?start=samples' })
        const gallery = await screen.findByRole('region', { name: 'Start from a sample' })
        await waitFor(() => expect(gallery.scrollIntoView).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByTestId('address')).toBeEmptyDOMElement())
    })
})
