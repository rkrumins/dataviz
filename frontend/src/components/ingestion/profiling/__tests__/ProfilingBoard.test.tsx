/**
 * The board — what an operator can actually do with it.
 *
 * These pin the behaviours the first version was missing rather than the
 * markup: that a row is a way IN, that "not observed" is reported as its own
 * fact rather than as a zero, and that a source with one observation is not
 * described as a failure.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardPayload, BoardRow } from '@/types/profiling'

vi.mock('@/hooks/useProfilingAccess', () => ({
    useCanReadProfiling: () => true,
    useCanEditProfilingPolicy: () => true,
    useIsPlatformOperator: () => true,
    INGESTION_READ_PERMS: [],
}))

const getBoard = vi.fn()
const getFindings = vi.fn()
const exportUrl = vi.fn((..._args: unknown[]) => '/api/v1/profiling/export.csv')

vi.mock('@/services/profilingService', () => ({
    profilingService: {
        getBoard: (...args: unknown[]) => getBoard(...args),
        getFindings: (...args: unknown[]) => getFindings(...args),
        getSeries: vi.fn().mockResolvedValue({
            buckets: [], series: [], totals: { nodes: [], edges: [], total: [] },
        }),
        getObservations: vi.fn().mockResolvedValue({
            id: 'ds_a', from: '', to: '', window: '30d', observations: [],
            total: 0, offset: 0, limit: 50,
            baselines: { nodes: 25, edges: 25 }, events: [],
            counts: { observations: 0, moved: 0, checkpoints: 0, runs: 0 },
        }),
        exportUrl: (...args: unknown[]) => exportUrl(...args),
        acknowledge: vi.fn(),
    },
}))

import { ProfilingBoard } from '../ProfilingBoard'

function LocationProbe() {
    const { search } = useLocation()
    return <span data-testid="location">{search}</span>
}

function row(over: Partial<BoardRow> = {}): BoardRow {
    return {
        data_source_id: 'ds_a', name: 'Customers', catalog_item_id: 'cat_a',
        workspace_id: 'ws_1', workspace_name: 'Platform',
        provider_id: 'prov_1', provider_name: 'Falkor Docker',
        provider_type: 'falkordb',
        first: 1000, last: 1000, delta: 0, pct_change: 0,
        points: [1000, 1000, 1000], observations: 3,
        last_observed_at: '2026-08-24T07', significance: 'normal', baseline: 25,
        ...over,
    }
}

function payload(rows: BoardRow[], over: Partial<BoardPayload> = {}): BoardPayload {
    return {
        from: '2026-07-25', to: '2026-08-24', window: '30d', metric: 'nodes',
        platform_wide: true, rows, total: rows.length, offset: 0, limit: 500,
        unobserved: 0, ...over,
    }
}

function renderBoard(props = {}, initialUrl = '/ingestion?tab=profiling') {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[initialUrl]}>
                <Routes>
                    <Route
                        path="/ingestion"
                        element={<><ProfilingBoard {...props} /><LocationProbe /></>}
                    />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

/** The board writes its state to the URL; this reads it back. */
function currentSearch(): URLSearchParams {
    const link = screen.getByTestId('location') as HTMLElement
    return new URLSearchParams(link.textContent ?? '')
}

describe('ProfilingBoard', () => {
    beforeEach(() => {
        getBoard.mockReset()
        getFindings.mockReset().mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 20,
            platform_wide: true,
        })
    })

    it('leads with a stat band, not a bare table', async () => {
        getBoard.mockResolvedValue(payload([row()], { unobserved: 4 }))
        renderBoard()

        expect(await screen.findByText('Sources reporting')).toBeInTheDocument()
        expect(screen.getByText('Need a look')).toBeInTheDocument()
        expect(screen.getByText('Not observed')).toBeInTheDocument()
    })

    it('reports unobserved sources as their own fact, never as a zero row', async () => {
        // A source that was not observed did not drop to nothing, and a row
        // showing it at zero would invent an outage.
        getBoard.mockResolvedValue(payload([row()], { unobserved: 12 }))
        renderBoard()

        expect(await screen.findByText('reported nothing in this window')).toBeInTheDocument()
        expect(screen.getAllByRole('row')).toHaveLength(2) // header + one source
    })

    it('opens a source when its row is chosen', async () => {
        // The whole point of the board: the source is the ANSWER, so a row has
        // to be a way in.
        const onOpenSource = vi.fn()
        getBoard.mockResolvedValue(payload([row()]))
        renderBoard({ onOpenSource })

        const cell = await screen.findByText('Customers')
        await userEvent.click(cell)
        expect(onOpenSource).toHaveBeenCalledWith(
            expect.objectContaining({ data_source_id: 'ds_a' }),
        )
    })

    it('opens its own drill-down when the host offers nowhere to send the reader', async () => {
        getBoard.mockResolvedValue(payload([row()]))
        renderBoard()

        await userEvent.click(await screen.findByText('Customers'))
        expect(
            await screen.findByRole('dialog', { name: /profiling for customers/i }),
        ).toBeInTheDocument()
    })

    it('ranks unusual movement above larger ordinary movement', async () => {
        // A catastrophic drop on a small graph must outrank ordinary churn on
        // a large one; sorting by magnitude alone buries the incident.
        getBoard.mockResolvedValue(payload([
            row({ data_source_id: 'ds_big', name: 'Big churn', delta: 900_000, significance: 'normal' }),
            row({ data_source_id: 'ds_bad', name: 'Small wipe', delta: -400, significance: 'critical' }),
        ]))
        renderBoard()

        await screen.findByText('Small wipe')
        const rows = screen.getAllByRole('row').slice(1)
        expect(within(rows[0]).getByText('Small wipe')).toBeInTheDocument()
    })

    it('filters by search', async () => {
        getBoard.mockResolvedValue(payload([
            row({ data_source_id: 'ds_a', name: 'Customers' }),
            row({ data_source_id: 'ds_b', name: 'Orders' }),
        ]))
        renderBoard()

        await screen.findByText('Customers')
        await userEvent.type(screen.getByRole('searchbox', { name: /search sources/i }), 'ord')

        await waitFor(() => {
            expect(screen.queryByText('Customers')).not.toBeInTheDocument()
        })
        expect(screen.getByText('Orders')).toBeInTheDocument()
    })

    it('offers a way back when filters hide everything', async () => {
        getBoard.mockResolvedValue(payload([row({ name: 'Customers' })]))
        renderBoard()

        await screen.findByText('Customers')
        await userEvent.type(screen.getByRole('searchbox', { name: /search sources/i }), 'zzz')

        expect(await screen.findByText(/nothing matches these filters/i)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /clear filters/i }))
        expect(await screen.findByText('Customers')).toBeInTheDocument()
    })

    it('does not describe a first observation as a failure', async () => {
        // "too few points" repeated down the page says nothing. A source at
        // its first capture is where a trend STARTS.
        getBoard.mockResolvedValue(payload([
            row({ points: [1000], observations: 1 }),
        ]))
        renderBoard()

        await screen.findByText('Customers')
        expect(screen.queryByText(/too few points/i)).not.toBeInTheDocument()
        expect(
            screen.getByRole('img', { name: /nothing to compare against yet/i }),
        ).toBeInTheDocument()
    })

    it('spends no ink on a series that did not move', async () => {
        // Drawing a sparkline through identical values renders a flat rule
        // with an end dot — thirty-two of those is the column saying "nothing
        // changed" over and over, which buries the rows that did change.
        getBoard.mockResolvedValue(payload([
            row({ data_source_id: 'ds_flat', name: 'Flat', points: [10, 10, 10], delta: 0 }),
            row({ data_source_id: 'ds_moved', name: 'Moved', points: [10, 40, 90], delta: 80 }),
        ]))
        renderBoard()

        await screen.findByText('Flat')
        expect(
            screen.getByRole('img', { name: /steady — unchanged/i }),
        ).toBeInTheDocument()
        // The mover is the only row drawn as a line.
        expect(screen.getByRole('img', { name: /Moved over the window/i })).toBeInTheDocument()
    })

    it('explains an empty window rather than showing an empty table', async () => {
        getBoard.mockResolvedValue(payload([]))
        renderBoard()

        expect(
            await screen.findByText(/no source has reported counts in this window/i),
        ).toBeInTheDocument()
    })

    it('surfaces a failed read instead of rendering it as emptiness', async () => {
        getBoard.mockRejectedValue(new Error('upstream exploded'))
        renderBoard()

        expect(await screen.findByText(/the board could not be read/i)).toBeInTheDocument()
        expect(screen.getByText(/upstream exploded/i)).toBeInTheDocument()
    })
})


describe('ProfilingBoard — shareable state', () => {
    beforeEach(() => {
        getBoard.mockReset().mockResolvedValue(payload([row()]))
        getFindings.mockReset().mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 20,
            platform_wide: true,
        })
    })

    it('reads its window from the URL', async () => {
        renderBoard({}, '/ingestion?tab=profiling&window=24h')
        await screen.findByText('Customers')
        expect(screen.getByRole('button', { name: '24 hours' })).toHaveAttribute(
            'aria-pressed', 'true',
        )
    })

    it('writes a chosen filter back, so the view can be sent to someone', async () => {
        renderBoard()
        await screen.findByText('Customers')

        await userEvent.click(screen.getByRole('button', { name: '24 hours' }))
        await waitFor(() => expect(currentSearch().get('window')).toBe('24h'))

        await userEvent.click(screen.getByRole('button', { name: /unusual only/i }))
        await waitFor(() => expect(currentSearch().get('unusual')).toBe('1'))
    })

    it('keeps a default OUT of the URL, so a shared link carries only choices', async () => {
        renderBoard({}, '/ingestion?tab=profiling&window=24h')
        await screen.findByText('Customers')

        await userEvent.click(screen.getByRole('button', { name: '7 days' }))
        await waitFor(() => expect(currentSearch().has('window')).toBe(false))
        // The host page's own param survives untouched.
        expect(currentSearch().get('tab')).toBe('profiling')
    })

    it('restores a full view from a pasted link', async () => {
        getBoard.mockResolvedValue(payload([
            row({ data_source_id: 'ds_a', name: 'Customers' }),
            row({ data_source_id: 'ds_b', name: 'Orders' }),
        ]))
        renderBoard({}, '/ingestion?tab=profiling&window=24h&measure=edges&q=ord')

        expect(await screen.findByText('Orders')).toBeInTheDocument()
        expect(screen.queryByText('Customers')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Relationships' })).toHaveAttribute(
            'aria-pressed', 'true',
        )
    })

    it('offers the whole board as CSV, not one source at a time', async () => {
        renderBoard()
        await screen.findByText('Customers')
        expect(screen.getByRole('link', { name: /export/i })).toBeInTheDocument()
        // The scope is what matters: the board exports the altitude it shows.
        expect(exportUrl).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'all', window: '7d' }),
        )
    })
})


describe('ProfilingBoard — export scope', () => {
    beforeEach(() => {
        getBoard.mockReset().mockResolvedValue(payload([row()]))
        getFindings.mockReset().mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 20,
            platform_wide: false,
        })
        exportUrl.mockClear()
    })

    it('exports one workspace when it is scoped to one', async () => {
        renderBoard({ workspaceId: 'ws_1' })
        await screen.findByText('Customers')
        expect(exportUrl).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'workspace', id: 'ws_1' }),
        )
    })
})
