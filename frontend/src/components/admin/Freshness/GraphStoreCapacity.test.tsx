/**
 * The capacity card says, per shard, what the write budget will see: a
 * meter with the reserve on it, what is free after the reserve, what that is
 * in rollup edges, and which sources live there. A shard it cannot measure
 * says why and what rule applies instead; a refused source is one click
 * from the table filtered to exactly those.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFleetCapacity } = vi.hoisted(() => ({ getFleetCapacity: vi.fn() }))

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return { ...actual, aggregationService: { ...actual.aggregationService, getFleetCapacity } }
})

import { GraphStoreCapacity } from './GraphStoreCapacity'

const GB = 2 ** 30

const LIMITS = {
    shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
    maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
    estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
}

const SNAPSHOT = {
    limits: LIMITS,
    shards: [
        {
            endpoint: '10.0.0.1:6379', used: 30 * GB, maxmemory: 40 * GB, policy: 'noeviction', measurable: true,
            usedPct: 75, reservePct: 20, reserveBytes: 8 * GB, availableBytes: 2 * GB, allowedGrowthEdges: Math.floor(2 * GB / 512),
            governedBy: 'shard', staticCap: 25_000_000, queryMemCapacity: 512 * 2 ** 20,
            reservedBytes: 1.5 * GB, reservedByJobs: 1,
            sources: [
                { dataSourceId: 'ds-big', label: 'Warehouse', edgeCount: 30_000_000, bytesPerEdge: 900, bytesPerEdgeSource: 'calibrated', footprintBytes: 27_000_000_000, lastFailureCategory: 'write_budget', lastCubeEstimate: 90_000_000, lastRegime: 'boundary' },
                { dataSourceId: 'ds-small', label: 'Orders', edgeCount: 50_000, bytesPerEdge: 512, bytesPerEdgeSource: 'default', footprintBytes: 25_600_000 },
            ],
        },
        {
            endpoint: '10.0.0.2:6379', used: null, maxmemory: 0, policy: null, measurable: false, whyNot: 'the shard reports no maxmemory',
            usedPct: null, reservePct: 20, reserveBytes: null, availableBytes: null, allowedGrowthEdges: null,
            governedBy: 'static', staticCap: 25_000_000, sources: [],
        },
    ],
    unresolved: [{ dataSourceId: 'ds-lost', label: 'Legacy', whyNot: 'provider unavailable (ConnectionError)' }],
    sourcesTotal: 3, truncated: false, measuredAt: '2026-09-08T10:00:00Z', cacheAgeMs: 0,
}

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    getFleetCapacity.mockResolvedValue(SNAPSHOT)
})

describe('GraphStoreCapacity', () => {
    it('shows each measured shard as a meter with the reserve, and what still fits', async () => {
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)

        const meter = await screen.findByRole('meter', { name: /30\.0 GB of 40\.0 GB used on 10\.0\.0\.1:6379; 20% reserved/ })
        expect(meter).toHaveAttribute('aria-valuenow', String(30 * GB))
        expect(screen.getByText(/2\.0 GB/)).toBeInTheDocument()
        expect(screen.getByText(/fits/)).toBeInTheDocument()
        expect(screen.getByText(/~4\.2M/)).toBeInTheDocument()
        expect(screen.getByText('Near the reserve')).toBeInTheDocument()
        // The per-query ceiling the rebuild narrows its scans against.
        expect(screen.getByText(/per-query limit 512 MB/)).toBeInTheDocument()
        // What another running rebuild holds on the node, already off the free figure.
        expect(screen.getByText(/and 1\.5 GB held by 1 running rebuild/)).toBeInTheDocument()
    })

    it('says why a shard cannot be measured and which rule applies instead', async () => {
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        await screen.findByText('10.0.0.2:6379')
        expect(screen.getByText('Cannot govern')).toBeInTheDocument()
        expect(screen.getByText(/The shard reports no maxmemory/)).toBeInTheDocument()
        expect(screen.getByText(/static cap of/)).toBeInTheDocument()
        expect(screen.getByText(/Not placed on a shard: Legacy \(provider unavailable/)).toBeInTheDocument()
    })

    it('tells a node that is not there apart from one that governs nothing', async () => {
        // The same words used to cover both, and "set maxmemory on this node"
        // is advice for a node that is running.
        getFleetCapacity.mockResolvedValue({
            ...SNAPSHOT,
            shards: [{
                ...SNAPSHOT.shards[1], endpoint: '10.0.0.3:6379', state: 'unreachable',
                whyNot: "the shard's memory could not be measured (Connection refused)",
            }],
        })
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        await screen.findByText('10.0.0.3:6379')
        expect(screen.getByText('Unreachable')).toBeInTheDocument()
        expect(screen.getByText(/Connection refused/)).toBeInTheDocument()
        expect(screen.getByText(/keep their checkpoint/)).toBeInTheDocument()
        expect(screen.queryByText(/static cap of/)).not.toBeInTheDocument()
    })

    it('keeps the rows when the reading behind them is the last good one', async () => {
        // Blanking the whole card on one failed poll — and filling it again on
        // the next — is the flicker an operator learned not to trust.
        getFleetCapacity.mockResolvedValue({
            ...SNAPSHOT, stale: true, lastError: 'no seed answered', cacheAgeMs: 42_000,
        })
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        await screen.findByText('10.0.0.1:6379')
        expect(screen.getByText(/Last refresh failed/)).toBeInTheDocument()
        expect(screen.getByText(/42s ago: no seed answered/)).toBeInTheDocument()
        expect(screen.queryByText(/Capacity could not be measured right now/)).not.toBeInTheDocument()
    })

    it('opens a source from its chip and filters the table to the refused ones', async () => {
        const onOpenSource = vi.fn()
        const onFacet = vi.fn()
        wrap(<GraphStoreCapacity onOpenSource={onOpenSource} onFacetWouldNotFit={onFacet} />)

        await userEvent.click(await screen.findByRole('button', { name: 'Open Warehouse' }))
        expect(onOpenSource).toHaveBeenCalledWith('ds-big')

        await userEvent.click(screen.getByRole('button', { name: /1 would not fit/ }))
        expect(onFacet).toHaveBeenCalledTimes(1)
    })

    it('offers Adjust limits only when the page says the viewer may', async () => {
        const onAdjust = vi.fn()
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} onAdjustLimits={onAdjust} />)
        await userEvent.click(await screen.findByRole('button', { name: /Adjust limits/ }))
        expect(onAdjust).toHaveBeenCalledTimes(1)

        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        expect(screen.getAllByRole('button', { name: /Adjust limits/ })).toHaveLength(1)
    })

    it('stays quiet when capacity cannot be read', async () => {
        getFleetCapacity.mockRejectedValue(new Error('503'))
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        // The hook retries once before it gives up.
        expect(await screen.findByText(/Capacity could not be measured right now/, {}, { timeout: 5000 })).toBeInTheDocument()
    })
})

describe('GraphStoreCapacity — collapsing it', () => {
    beforeEach(() => {
        try { localStorage.clear() } catch { /* not every environment has one */ }
    })

    it('opens expanded and collapses to a summary that still names the tightest shard', async () => {
        const user = userEvent.setup()
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)

        const toggle = await screen.findByTestId('capacity-toggle')
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await screen.findByRole('meter', { name: /10\.0\.0\.1:6379/ })

        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        // The body is hidden, not unmounted — `hidden` keeps it out of the
        // accessibility tree, which is what a screen reader needs.
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()

        // Collapsed still has to be worth reading: hiding a shard that is
        // nearly full behind a chevron is how a rebuild gets refused by a
        // number nobody saw.
        const summary = screen.getByTestId('capacity-collapsed-summary')
        expect(summary).toHaveTextContent(/tightest 10\.0\.0\.1:6379 with 2\.0 GB free/)
        expect(summary).toHaveTextContent(/not placed/)
    })

    it('remembers the choice for this viewer, and survives storage being unavailable', async () => {
        const user = userEvent.setup()
        const { unmount } = wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        await user.click(await screen.findByTestId('capacity-toggle'))
        expect(localStorage.getItem('freshness.capacity.collapsed')).toBe('true')
        unmount()

        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        expect(await screen.findByTestId('capacity-toggle')).toHaveAttribute('aria-expanded', 'false')
    })

    it('renders open when storage throws, rather than not at all', async () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('site data blocked')
        })
        try {
            wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
            // Open is the state that shows the numbers, so it is the one to
            // fail into.
            expect(await screen.findByTestId('capacity-toggle'))
                .toHaveAttribute('aria-expanded', 'true')
        } finally {
            getItem.mockRestore()
        }
    })
})
