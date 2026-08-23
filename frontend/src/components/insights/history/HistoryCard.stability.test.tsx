/**
 * The card must SETTLE.
 *
 * `HistoryCard.test.tsx` mocks `useCountHistory`, which is right for asserting
 * what the card renders — and is exactly why it could not see this: the query
 * key never participated. `resolveWindow` ends its range at `new Date()`, so
 * computing the range during render handed every render a new key, hence a new
 * pending query, hence another render. The card showed "Loading history…"
 * forever and refetched in a loop for as long as it was mounted.
 *
 * So this file mocks only the SERVICE and drives the real hook through a real
 * QueryClient: one mount, one request, and no "Loading" left behind.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDataSourceHistory = vi.fn()

vi.mock('@/hooks/useHistoryAccess', () => ({
    useCanReadHistory: () => true,
}))
vi.mock('@/services/insightsHistoryService', () => ({
    insightsHistoryService: {
        getDataSourceHistory: (...args: unknown[]) => getDataSourceHistory(...args),
    },
}))

import { HistoryCard } from './HistoryCard'

function envelope() {
    return {
        data: {
            data_source_id: 'ds_1', from: 'a', to: 'b', grain: 'raw',
            points: [], labels: [], edge_labels: [], events: [],
            summary: {
                node_first: 0, node_last: 0, node_delta: 0, node_pct_change: null,
                edge_first: 0, edge_last: 0, edge_delta: 0, edge_pct_change: null,
                snapshots: 0, changed_snapshots: 0,
                labels_added: [], labels_removed: [], largest_drop: null,
                change_baseline: 25, notable_changes: 0, severe_changes: 0,
                coverage_from: null, retention_days: 90,
            },
        },
        meta: { state: 'fresh' },
    }
}

function mount() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <HistoryCard dataSourceId="ds_1" catalogId="cat_1" />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('HistoryCard — settles instead of looping', () => {
    beforeEach(() => {
        getDataSourceHistory.mockReset()
        getDataSourceHistory.mockResolvedValue(envelope())
    })

    it('stops loading, and asks the server exactly once', async () => {
        mount()
        await waitFor(() => {
            expect(screen.queryByText(/loading history/i)).toBeNull()
        })
        expect(getDataSourceHistory).toHaveBeenCalledTimes(1)
    })

    it('does not keep refetching after it has settled', async () => {
        mount()
        await waitFor(() => expect(getDataSourceHistory).toHaveBeenCalledTimes(1))
        // Let several render/microtask cycles pass. A range recomputed during
        // render would have produced a fresh key — and another request — by now.
        for (let i = 0; i < 5; i++) await Promise.resolve()
        await new Promise((r) => setTimeout(r, 50))
        expect(getDataSourceHistory).toHaveBeenCalledTimes(1)
    })
})
