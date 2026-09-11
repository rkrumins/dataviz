/**
 * The cache card is where someone decides whether slow views are a cache
 * problem. So the things worth pinning are the ones that would mislead that
 * decision: a fallback counted as a hit, a disabled cache reading as a broken
 * one, and a destructive control that is easy to press by accident.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CacheHealthCard } from './CacheHealthCard'
import { graphStoreService } from '@/services/graphStoreService'

vi.mock('@/services/graphStoreService', () => ({
    graphStoreService: { getCacheStats: vi.fn(), refreshCache: vi.fn() },
}))

const stats = (over = {}) => ({
    workspaceId: 'ws1',
    dataSourceId: 'ds1',
    windowSeconds: 7200,
    totals: { hit: 80, miss: 20, stale: 0, bypass: 0, hit_ratio: 0.8 },
    endpoints: {
        'canvas-bootstrap': { hit: 50, miss: 10, stale: 0, bypass: 0, hit_ratio: 0.833 },
        'children-with-edges': { hit: 30, miss: 10, stale: 0, bypass: 0, hit_ratio: 0.75 },
    },
    ...over,
})

beforeEach(() => {
    vi.mocked(graphStoreService.getCacheStats).mockResolvedValue(stats() as never)
    vi.mocked(graphStoreService.refreshCache).mockResolvedValue({
        workspaceId: 'ws1', dataSourceId: 'ds1', invalidated: true,
        fallbackKept: true, fallbackEntriesPurged: 0,
    } as never)
})

describe('CacheHealthCard', () => {
    it('leads with the ratio and names each endpoint in terms of what the user did', async () => {
        render(<CacheHealthCard workspaceId="ws1" dataSourceId="ds1" canRefresh />)
        expect(await screen.findByText('80%')).toBeInTheDocument()
        // Not "canvas-bootstrap" alone — the endpoint name means nothing to
        // whoever is deciding whether views are slow.
        expect(screen.getByText('Opening a view for the first time')).toBeInTheDocument()
        expect(screen.getByText('Expanding a node to see what it contains')).toBeInTheDocument()
    })

    it('reports a fallback separately, never inside the ratio', async () => {
        vi.mocked(graphStoreService.getCacheStats).mockResolvedValue(stats({
            totals: { hit: 10, miss: 10, stale: 80, bypass: 0, hit_ratio: 0.1 },
        }) as never)
        render(<CacheHealthCard workspaceId="ws1" canRefresh={false} />)

        // 10 real hits of 100 served. If the 80 fallbacks were folded in this
        // would read 90% — an outage would look like the cache working.
        expect(await screen.findByText('10%')).toBeInTheDocument()
        expect(screen.getByText('Fell back')).toBeInTheDocument()
    })

    it('says nothing was served rather than showing a misleading zero', async () => {
        vi.mocked(graphStoreService.getCacheStats).mockResolvedValue(stats({
            totals: { hit: 0, miss: 0, stale: 0, bypass: 0, hit_ratio: null },
            endpoints: {},
        }) as never)
        render(<CacheHealthCard workspaceId="ws1" canRefresh={false} />)
        expect(await screen.findByText(/Nothing served in this window/)).toBeInTheDocument()
    })

    it('hides the rebuild control from anyone who cannot use it', async () => {
        render(<CacheHealthCard workspaceId="ws1" dataSourceId="ds1" canRefresh={false} />)
        await screen.findByText('80%')
        expect(screen.queryByRole('button', { name: /rebuild/i })).not.toBeInTheDocument()
    })

    it('rebuilds the source and says who pays for it', async () => {
        render(<CacheHealthCard workspaceId="ws1" dataSourceId="ds1" canRefresh />)
        await screen.findByText('80%')
        await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))

        await waitFor(() => {
            expect(graphStoreService.refreshCache).toHaveBeenCalledWith('ws1', 'ds1')
        })
        // The consequence, not just "done" — the cost lands on the next reader.
        expect(await screen.findByText(/next person to open each view rebuilds it/i))
            .toBeInTheDocument()
    })

    it('surfaces a failed refresh instead of looking like it worked', async () => {
        vi.mocked(graphStoreService.refreshCache).mockRejectedValue(new Error('nope'))
        render(<CacheHealthCard workspaceId="ws1" dataSourceId="ds1" canRefresh />)
        await screen.findByText('80%')
        await userEvent.click(screen.getByRole('button', { name: /rebuild/i }))
        expect(await screen.findByText('nope')).toBeInTheDocument()
    })
})
