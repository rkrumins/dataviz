import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const useCountHistory = vi.fn()
const useProviderHistory = vi.fn()

vi.mock('@/hooks/useCountHistory', async () => {
    const actual = await vi.importActual<typeof import('@/hooks/useCountHistory')>(
        '@/hooks/useCountHistory',
    )
    return {
        ...actual,
        useCountHistory: (...a: unknown[]) => useCountHistory(...a),
        useProviderHistory: (...a: unknown[]) => useProviderHistory(...a),
    }
})
vi.mock('@/hooks/useDataSourceProfile', () => ({
    useDataSourceProfile: () => ({
        item: { id: 'cat-1', providerId: 'p-1', name: 'Orders Graph' },
        provider: { id: 'p-1', name: 'Falkor Docker', providerType: 'falkordb' },
    }),
}))

import { DataSourceHistoryPage } from './DataSourceHistoryPage'

function point(at: string, nodes: number, over: Record<string, unknown> = {}) {
    return {
        at, node_count: nodes, edge_count: nodes * 2,
        entity_type_counts: { Table: nodes }, edge_type_counts: { OWNS: nodes * 2 },
        node_delta: null, edge_delta: null, node_min: null, node_max: null,
        lane: 'probe', capture_reason: 'changed', ...over,
    }
}

const SOURCE_PAYLOAD = {
    data: {
        data_source_id: 'ds-1',
        from: '2026-07-21T00:00:00Z', to: '2026-08-20T00:00:00Z', grain: 'day',
        points: [
            point('2026-08-18T00:00:00Z', 100),
            point('2026-08-19T00:00:00Z', 120, { node_delta: 20 }),
            point('2026-08-20T00:00:00Z', 130, { node_delta: 10 }),
        ],
        labels: [{ label: 'Table', first: 100, last: 130, delta: 30, state: 'grew', points: [100, 120, 130] }],
        edge_labels: [],
        summary: {
            node_first: 100, node_last: 130, node_delta: 30, node_pct_change: 30,
            edge_first: 200, edge_last: 260, edge_delta: 60, edge_pct_change: 30,
            snapshots: 3, changed_snapshots: 3,
            labels_added: [], labels_removed: [], largest_drop: null,
            coverage_from: '2026-08-18T00:00:00Z', retention_days: 90,
        },
    },
    meta: {},
}

function renderPage(search = '') {
    return render(
        <MemoryRouter initialEntries={[`/datasources/cat-1/history${search}`]}>
            <Routes>
                <Route path="/datasources/:catalogId/history" element={<DataSourceHistoryPage />} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('DataSourceHistoryPage', () => {
    it('shows a skeleton while loading', () => {
        useCountHistory.mockReturnValue({ data: undefined, isLoading: true })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.queryByText('Counts by type')).toBeNull()
    })

    it('renders the KPI strip, chart and both ledgers', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()

        expect(screen.getByText('Entities now')).toBeInTheDocument()
        expect(screen.getByText('Relationships now')).toBeInTheDocument()
        expect(screen.getByText('Entities over time')).toBeInTheDocument()
        expect(screen.getByText('Counts by type')).toBeInTheDocument()
        expect(screen.getByText('Change ledger')).toBeInTheDocument()
    })

    it('reports no largest drop when nothing was lost', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText('Largest drop')).toBeInTheDocument()
        expect(screen.getByText(/nothing was lost in this window/i)).toBeInTheDocument()
    })

    it('promotes a real drop to its own actionable tile', () => {
        useCountHistory.mockReturnValue({
            data: {
                ...SOURCE_PAYLOAD,
                data: {
                    ...SOURCE_PAYLOAD.data,
                    summary: {
                        ...SOURCE_PAYLOAD.data.summary,
                        largest_drop: {
                            at: '2026-08-19T00:00:00Z', label: 'Column',
                            before: 900, after: 100, delta: -800,
                        },
                    },
                },
            },
            isLoading: false,
        })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText('−800')).toBeInTheDocument()
        expect(screen.getByText(/Column ·/)).toBeInTheDocument()
    })

    it('states how much of the window history actually covers', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText(/retention/i)).toBeInTheDocument()
        expect(screen.getByText('90 days')).toBeInTheDocument()
    })

    it('explains an empty history instead of rendering a blank chart', () => {
        useCountHistory.mockReturnValue({
            data: { data: { ...SOURCE_PAYLOAD.data, points: [] }, meta: {} },
            isLoading: false,
        })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText('No history yet')).toBeInTheDocument()
    })

    it('switches to the provider rollup and keeps it in the URL', async () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({
            data: {
                data: {
                    provider_id: 'p-1', from: '', to: '', grain: 'hour',
                    totals: [
                        { at: '2026-08-19T00', node_count: 100, edge_count: 10, sources: 2 },
                        { at: '2026-08-20T00', node_count: 150, edge_count: 20, sources: 2 },
                    ],
                    sources: [
                        {
                            data_source_id: 'ds-1', name: 'orders',
                            points: [
                                { at: '2026-08-19T00', node_count: 60, edge_count: 6 },
                                { at: '2026-08-20T00', node_count: 90, edge_count: 12 },
                            ],
                        },
                    ],
                    retention_days: 90,
                },
                meta: {},
            },
            isLoading: false,
        })
        renderPage()

        await userEvent.click(screen.getByRole('button', { name: /all on falkor docker/i }))
        expect(screen.getByText('Entities across provider')).toBeInTheDocument()
        expect(screen.getByText('By data source')).toBeInTheDocument()
        expect(screen.getByText('orders')).toBeInTheDocument()
    })

    it('reads the chart mode from the URL', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage('?mode=compare')
        expect(screen.getByRole('button', { name: /compare/i })).toHaveAttribute(
            'aria-pressed', 'true',
        )
    })
})
