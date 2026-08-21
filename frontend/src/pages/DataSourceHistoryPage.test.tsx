import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const useCountHistory = vi.fn()
const useProviderHistory = vi.fn()
const useFleetHistory = vi.fn()

vi.mock('@/hooks/useCountHistory', async () => {
    const actual = await vi.importActual<typeof import('@/hooks/useCountHistory')>(
        '@/hooks/useCountHistory',
    )
    return {
        ...actual,
        useCountHistory: (...a: unknown[]) => useCountHistory(...a),
        useProviderHistory: (...a: unknown[]) => useProviderHistory(...a),
        useFleetHistory: (...a: unknown[]) => useFleetHistory(...a),
    }
})
// Both of these fetch for themselves and have their own dedicated tests; the
// page's job is only to mount them in the right place. Stubbing them keeps
// this file about layout and URL state, and keeps a QueryClient out of it.
vi.mock('@/components/insights/history/HistorySettingsDialog', () => ({
    HistorySettingsDialog: () => <div data-testid="history-settings-dialog" />,
}))
vi.mock('@/components/insights/history/AlertBand', () => ({
    AlertBand: () => <div data-testid="alert-band" />,
}))
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
        lane: 'probe', capture_reason: 'changed', significance: 'normal', ...over,
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
        events: [],
        summary: {
            node_first: 100, node_last: 130, node_delta: 30, node_pct_change: 30,
            edge_first: 200, edge_last: 260, edge_delta: 60, edge_pct_change: 30,
            snapshots: 3, changed_snapshots: 3,
            labels_added: [], labels_removed: [], largest_drop: null,
            change_baseline: 500, notable_changes: 0, severe_changes: 0,
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
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.queryByText('Counts by type')).toBeNull()
    })

    it('renders the KPI strip, chart and both ledgers', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
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
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
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
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText('−800')).toBeInTheDocument()
        expect(screen.getByText(/Column ·/)).toBeInTheDocument()
    })

    it('states how much of the window history actually covers', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
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
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
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

    it('offers a raw CSV export scoped to the visible window', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()

        const link = screen.getByRole('link', { name: /export/i })
        const href = link.getAttribute('href') ?? ''
        expect(href).toContain('/history.csv')
        expect(href).toContain('from=')
        // Grain never travels: an export is evidence, not a rendering.
        expect(href).not.toContain('grain=')
    })

    it('hides the export when there is nothing to export', () => {
        useCountHistory.mockReturnValue({
            data: { data: { ...SOURCE_PAYLOAD.data, points: [] }, meta: {} },
            isLoading: false,
        })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.queryByRole('link', { name: /export/i })).toBeNull()
    })

    it('mounts the alert band above the chart', () => {
        // Someone arriving from a notification should find the incident
        // already named, not have to locate it on a timeline.
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByTestId('alert-band')).toBeInTheDocument()
    })

    it('offers the guided explainer', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.getByText(/reading this history/i)).toBeInTheDocument()
    })

    it('offers an unusual-only filter when there is something unusual', async () => {
        useCountHistory.mockReturnValue({
            data: {
                ...SOURCE_PAYLOAD,
                data: {
                    ...SOURCE_PAYLOAD.data,
                    points: [
                        point('2026-08-18T00:00:00Z', 100),
                        point('2026-08-19T00:00:00Z', 5, {
                            node_delta: -95, significance: 'severe',
                        }),
                    ],
                    summary: {
                        ...SOURCE_PAYLOAD.data.summary,
                        notable_changes: 0, severe_changes: 1,
                    },
                },
            },
            isLoading: false,
        })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()

        const filter = screen.getByRole('button', { name: /unusual only \(1\)/i })
        expect(filter).toHaveAttribute('aria-pressed', 'false')
        await userEvent.click(filter)
        expect(filter).toHaveAttribute('aria-pressed', 'true')
    })

    it('does not offer the filter when nothing is unusual', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage()
        expect(screen.queryByRole('button', { name: /unusual only/i })).toBeNull()
    })

    it('switches to the platform rollup and names it by provider', async () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({
            data: {
                data: {
                    provider_id: 'fleet', from: '', to: '', grain: 'day',
                    totals: [
                        { at: '2026-08-19', node_count: 100, edge_count: 10, sources: 3 },
                        { at: '2026-08-20', node_count: 260, edge_count: 20, sources: 3 },
                    ],
                    sources: [
                        {
                            data_source_id: 'p-1', name: 'Falkor Prod',
                            points: [
                                { at: '2026-08-19', node_count: 60, edge_count: 6 },
                                { at: '2026-08-20', node_count: 160, edge_count: 12 },
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

        await userEvent.click(screen.getByRole('button', { name: /whole platform/i }))
        expect(screen.getByText('Entities platform-wide')).toBeInTheDocument()
        expect(screen.getByText('By provider')).toBeInTheDocument()
        expect(screen.getByText('Falkor Prod')).toBeInTheDocument()
    })

    it('reads the chart mode from the URL', () => {
        useCountHistory.mockReturnValue({ data: SOURCE_PAYLOAD, isLoading: false })
        useProviderHistory.mockReturnValue({ data: undefined, isLoading: false })
        useFleetHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderPage('?mode=compare')
        expect(screen.getByRole('button', { name: /compare/i })).toHaveAttribute(
            'aria-pressed', 'true',
        )
    })
})
