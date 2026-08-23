import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useCountHistory = vi.fn()
const useAnyPermission = vi.fn()

vi.mock('@/hooks/useHistoryAccess', () => ({
    useCanReadHistory: () => useAnyPermission(),
}))
vi.mock('@/hooks/useCountHistory', async () => {
    const actual = await vi.importActual<typeof import('@/hooks/useCountHistory')>(
        '@/hooks/useCountHistory',
    )
    return { ...actual, useCountHistory: (...args: unknown[]) => useCountHistory(...args) }
})

import { HistoryCard } from './HistoryCard'

function point(at: string, nodes: number, reason = 'changed') {
    return {
        at, node_count: nodes, edge_count: 0,
        entity_type_counts: { Table: nodes }, edge_type_counts: {},
        node_delta: null, edge_delta: null, node_min: null, node_max: null,
        lane: 'probe', capture_reason: reason,
    }
}

function payload(points: ReturnType<typeof point>[], over: Record<string, unknown> = {}) {
    const first = points[0]?.node_count ?? 0
    const last = points[points.length - 1]?.node_count ?? 0
    return {
        data: {
            data_source_id: 'ds-1', from: '', to: '', grain: 'raw',
            points, labels: [], edge_labels: [],
            summary: {
                node_first: first, node_last: last, node_delta: last - first,
                node_pct_change: first ? ((last - first) / first) * 100 : null,
                edge_first: 0, edge_last: 0, edge_delta: 0, edge_pct_change: null,
                snapshots: points.length,
                changed_snapshots: points.filter(p => p.capture_reason !== 'heartbeat').length,
                labels_added: [], labels_removed: [], largest_drop: null,
                coverage_from: points[0]?.at ?? null, retention_days: 90,
                ...over,
            },
        },
        meta: {},
    }
}

function renderCard(props: Partial<Parameters<typeof HistoryCard>[0]> = {}) {
    return render(
        <MemoryRouter>
            <HistoryCard dataSourceId="ds-1" catalogId="cat-1" {...props} />
        </MemoryRouter>,
    )
}

describe('HistoryCard', () => {
    beforeEach(() => {
        useAnyPermission.mockReturnValue(true)
    })

    it('renders nothing for a viewer who cannot read history', () => {
        // The API is system:admin. Showing an empty card that explains nothing
        // is worse than showing no card, and firing the request would pop the
        // global permission modal over a profile they may legitimately open.
        useAnyPermission.mockReturnValue(false)
        useCountHistory.mockReturnValue({ data: undefined, isLoading: false })
        const { container } = renderCard()
        expect(container).toBeEmptyDOMElement()
    })

    it('does not fetch history it is not allowed to read', () => {
        useAnyPermission.mockReturnValue(false)
        useCountHistory.mockReturnValue({ data: undefined, isLoading: false })
        renderCard()
        expect(useCountHistory).toHaveBeenCalledWith(
            'ds-1', expect.anything(), expect.objectContaining({ enabled: false }),
        )
    })

    it('shows a loading state while the query is in flight', () => {
        useCountHistory.mockReturnValue({ data: undefined, isLoading: true })
        renderCard()
        expect(screen.getByText(/loading history/i)).toBeInTheDocument()
    })

    it('explains that history has not started yet rather than drawing nothing', () => {
        useCountHistory.mockReturnValue({ data: payload([]), isLoading: false })
        renderCard()
        expect(screen.getByText(/history starts with the next snapshot/i)).toBeInTheDocument()
    })

    it('does not draw a trend from too few points', () => {
        useCountHistory.mockReturnValue({
            data: payload([point('2026-08-19T00:00:00Z', 10)]), isLoading: false,
        })
        const { container } = renderCard()
        expect(screen.getByText(/history starts here/i)).toBeInTheDocument()
        // The header icon is an <svg> too — a sparkline is specifically a
        // <polyline>, so that is what "no trend was drawn" means here.
        expect(container.querySelector('polyline')).toBeNull()
    })

    it('renders the current count, the window delta and a sparkline', () => {
        useCountHistory.mockReturnValue({
            data: payload([
                point('2026-08-18T00:00:00Z', 100),
                point('2026-08-19T00:00:00Z', 110),
                point('2026-08-20T00:00:00Z', 130),
            ]),
            isLoading: false,
        })
        const { container } = renderCard()
        expect(screen.getByText('130')).toBeInTheDocument()
        expect(screen.getByText('+30')).toBeInTheDocument()
        expect(screen.getByText('+30%')).toBeInTheDocument()
        expect(container.querySelector('polyline')).not.toBeNull()
    })

    it('calls out a label that disappeared', () => {
        useCountHistory.mockReturnValue({
            data: payload(
                [
                    point('2026-08-18T00:00:00Z', 100),
                    point('2026-08-19T00:00:00Z', 90),
                    point('2026-08-20T00:00:00Z', 60),
                ],
                { labels_removed: ['Column'] },
            ),
            isLoading: false,
        })
        renderCard()
        expect(screen.getByText(/1 label disappeared/i)).toBeInTheDocument()
    })

    it('links to the full history, carrying the data source it is showing', () => {
        useCountHistory.mockReturnValue({
            data: payload([
                point('2026-08-18T00:00:00Z', 100),
                point('2026-08-19T00:00:00Z', 110),
                point('2026-08-20T00:00:00Z', 130),
            ]),
            isLoading: false,
        })
        renderCard()
        expect(screen.getByRole('link', { name: /full history/i })).toHaveAttribute(
            'href', '/datasources/cat-1/history?ds=ds-1',
        )
    })

    it('omits the link when there is no catalog identity to link to', () => {
        useCountHistory.mockReturnValue({ data: payload([]), isLoading: false })
        renderCard({ catalogId: null })
        expect(screen.queryByRole('link', { name: /full history/i })).toBeNull()
    })
})
