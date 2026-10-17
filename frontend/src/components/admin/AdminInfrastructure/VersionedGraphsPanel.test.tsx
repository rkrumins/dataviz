/**
 * The fleet inventory on Admin → Infrastructure: every versioned graph, not
 * just the projection panel's worst eight. It names each graph and its key,
 * marks forks, orphans and platform-owned keys, pages by cursor, filters on
 * the server, and lets an administrator rebuild a graph's cache, check it
 * against Postgres, open its data source, or move a fork to the trash. The
 * projection panel links to it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { versionedGraphs, rebuildProjection, reconcileProjection, deleteFork } = vi.hoisted(() => ({
    versionedGraphs: vi.fn(),
    rebuildProjection: vi.fn(),
    reconcileProjection: vi.fn(),
    deleteFork: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, versionedGraphs } }
})
vi.mock('@/services/versioningApiService', () => ({ rebuildProjection, reconcileProjection, deleteFork }))

import { VersionedGraphsPanel } from './VersionedGraphsPanel'
import { ProjectionPanel } from './ProjectionPanel'
import type { GraphProvider, ProjectionSection, VersionedGraphRow } from '@/services/systemStatusService'

const PROVIDERS: GraphProvider[] = [
    { id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true },
]

function row(over: Partial<VersionedGraphRow>): VersionedGraphRow {
    return {
        graphId: 'graph_a', workspaceId: 'ws1', workspaceName: 'Sales', dataSourceId: 'ds1',
        dataSourceLabel: 'Customer 360', providerName: 'Primary', providerType: 'falkordb', kind: 'manual',
        falkorGraphName: 'customer_360', falkorProvider: 'falkor-eu', committed: 3, projected: 3, target: 3,
        lag: 0, status: 'idle', lastError: null, lastProjectedAt: null, progressDone: null, progressTotal: null,
        updatedAt: null, owned: false, forkParentGraphId: null, orphan: false,
        ...over,
    }
}

const MAIN = row({})
const FORK = row({
    graphId: 'graph_b', dataSourceId: 'dsfork_1', dataSourceLabel: null, falkorGraphName: 'gv_fork_b',
    owned: true, forkParentGraphId: 'graph_a', lag: 2, committed: 5, projected: 3,
})
const ORPHAN = row({
    graphId: 'graph_c', dataSourceId: 'ds_gone', dataSourceLabel: null, workspaceName: null,
    falkorGraphName: 'old_key', orphan: true, lastError: 'connection refused',
})

function Where() {
    const loc = useLocation()
    return <span data-testid="where">{loc.pathname}{loc.search}</span>
}

function renderPanel() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/admin/infrastructure']}>
                <Routes>
                    <Route path="/admin/infrastructure" element={<VersionedGraphsPanel providers={PROVIDERS} onClose={() => {}} />} />
                    <Route path="/workspaces/:wsId" element={<Where />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    versionedGraphs.mockReset()
    rebuildProjection.mockReset()
    reconcileProjection.mockReset()
    deleteFork.mockReset()
    vi.restoreAllMocks()
})

describe('VersionedGraphsPanel', () => {
    it('lists every graph with its key and marks forks, orphans and keys the platform owns', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        renderPanel()

        expect(await screen.findByText('Customer 360')).toBeInTheDocument()
        expect(screen.getByText('customer_360')).toBeInTheDocument()
        expect(within(screen.getByRole('table')).getAllByText('EU graph store')).toHaveLength(3)
        expect(screen.getByText('dsfork_1')).toBeInTheDocument()
        expect(screen.getByText('Fork')).toBeInTheDocument()
        expect(screen.getByText('Orphan')).toBeInTheDocument()
        expect(screen.getByText('Platform copy')).toBeInTheDocument()
        expect(screen.getAllByText('Customer graph')).toHaveLength(2)
        expect(screen.getByText('connection refused')).toBeInTheDocument()
        expect(versionedGraphs).toHaveBeenCalledWith({}, null)
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    })

    it('pages on with the cursor and keeps the rows it has', async () => {
        versionedGraphs
            .mockResolvedValueOnce({ graphs: [MAIN], nextCursor: 'graph_a' })
            .mockResolvedValueOnce({ graphs: [FORK], nextCursor: null })
        renderPanel()

        await userEvent.click(await screen.findByRole('button', { name: /load more/i }))
        expect(await screen.findByText('dsfork_1')).toBeInTheDocument()
        expect(screen.getByText('Customer 360')).toBeInTheDocument()
        expect(versionedGraphs).toHaveBeenLastCalledWith({}, 'graph_a')
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    })

    it('filters on the server by provider, status, kind and search', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN], nextCursor: null })
        renderPanel()
        await screen.findByText('Customer 360')

        await userEvent.selectOptions(screen.getByLabelText('Provider'), 'falkor-eu')
        await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed')
        await userEvent.selectOptions(screen.getByLabelText('Kind'), 'orphan')
        await userEvent.type(screen.getByLabelText('Search'), 'customer{Enter}')

        await waitFor(() => expect(versionedGraphs).toHaveBeenLastCalledWith(
            { provider: 'falkor-eu', status: 'failed', kind: 'orphan', q: 'customer' }, null))
    })

    it('rebuilds a graph and checks it against Postgres from its row', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN, FORK], nextCursor: null })
        rebuildProjection.mockResolvedValue({ started: true, alreadyRunning: false, watermark: {} })
        reconcileProjection.mockResolvedValue({
            inSync: false, skippedReason: null, missingNodes: [{ entityId: 'e1' }, { entityId: 'e2' }],
            extraNodes: [], missingEdges: [], extraEdges: ['x'], mismatched: [],
        })
        renderPanel()
        await screen.findByText('Customer 360')

        await userEvent.click(screen.getAllByRole('button', { name: 'Rebuild' })[1])
        expect(rebuildProjection).toHaveBeenCalledWith('ws1', 'graph_b')
        expect(await screen.findByText('Rebuild started')).toBeInTheDocument()

        await userEvent.click(screen.getAllByRole('button', { name: 'Check sync' })[0])
        expect(reconcileProjection).toHaveBeenCalledWith('ws1', 'graph_a')
        expect(await screen.findByText('Out of sync: 2 missing, 1 extra')).toBeInTheDocument()
    })

    it('says so when a check finds the cache in sync, and shows a refusal as given', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN], nextCursor: null })
        reconcileProjection.mockResolvedValue({
            inSync: true, skippedReason: null, missingNodes: [], extraNodes: [], missingEdges: [], extraEdges: [], mismatched: [],
        })
        rebuildProjection.mockRejectedValue(new Error('no FalkorDB projection target for this graph'))
        renderPanel()
        await screen.findByText('Customer 360')

        await userEvent.click(screen.getByRole('button', { name: 'Check sync' }))
        expect(await screen.findByText('In sync with Postgres')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
        expect(await screen.findByText('no FalkorDB projection target for this graph')).toBeInTheDocument()
    })

    it("opens a graph's data source on its versioning tab, and only where there is one", async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        renderPanel()
        await screen.findByText('Customer 360')

        const open = screen.getAllByRole('button', { name: 'Open source' })
        expect(open.map(b => (b as HTMLButtonElement).disabled)).toEqual([false, true, true])
        await userEvent.click(open[0])
        expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1?ds=ds1&dstab=versioning')
    })

    it('moves a fork to the trash from its row on confirm, and offers it on forks only', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        deleteFork.mockResolvedValue(undefined)
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
        renderPanel()
        await screen.findByText('Customer 360')

        const del = screen.getAllByRole('button', { name: 'Delete' })
        expect(del).toHaveLength(1)
        expect(within(del[0].closest('tr')!).getByText('dsfork_1')).toBeInTheDocument()

        await userEvent.click(del[0])
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(deleteFork).not.toHaveBeenCalled()

        await userEvent.click(del[0])
        expect(deleteFork).toHaveBeenCalledWith('ws1', 'graph_b')
        expect(await screen.findByText('Moved to the trash; restorable for 30 days')).toBeInTheDocument()
        await waitFor(() => expect(versionedGraphs).toHaveBeenCalledTimes(2))
    })

    it('shows a refused delete as given', async () => {
        versionedGraphs.mockResolvedValue({ graphs: [FORK], nextCursor: null })
        deleteFork.mockRejectedValue(new Error('Forks were made from this fork. Delete its forks first.'))
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        renderPanel()

        await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
        expect(await screen.findByText('Forks were made from this fork. Delete its forks first.')).toBeInTheDocument()
        expect(versionedGraphs).toHaveBeenCalledTimes(1)
    })
})

describe('ProjectionPanel', () => {
    const PROJECTION: ProjectionSection = {
        totalGraphs: 3, fresh: 3, lagging: 0, projecting: 0, rebuilding: 0, evicted: 0, failed: 0, maxLag: 0, worst: [],
    }

    it('links to the full list of versioned graphs', async () => {
        const onShowAll = vi.fn()
        render(
            <MemoryRouter>
                <ProjectionPanel projection={PROJECTION} providers={PROVIDERS} onShowAll={onShowAll} />
            </MemoryRouter>,
        )
        await userEvent.click(screen.getByRole('button', { name: /all versioned graphs/i }))
        expect(onShowAll).toHaveBeenCalled()
    })

    it('offers no link to someone who cannot open the list', () => {
        render(
            <MemoryRouter>
                <ProjectionPanel projection={PROJECTION} providers={PROVIDERS} />
            </MemoryRouter>,
        )
        expect(screen.queryByRole('button', { name: /all versioned graphs/i })).not.toBeInTheDocument()
    })
})
