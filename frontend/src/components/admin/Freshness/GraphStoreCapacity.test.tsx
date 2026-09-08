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
            governedBy: 'shard', staticCap: 25_000_000,
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
    })

    it('says why a shard cannot be measured and which rule applies instead', async () => {
        wrap(<GraphStoreCapacity onOpenSource={() => {}} onFacetWouldNotFit={() => {}} />)
        await screen.findByText('10.0.0.2:6379')
        expect(screen.getByText(/The shard reports no maxmemory/)).toBeInTheDocument()
        expect(screen.getByText(/static cap of/)).toBeInTheDocument()
        expect(screen.getByText(/Not placed on a shard: Legacy \(provider unavailable/)).toBeInTheDocument()
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
