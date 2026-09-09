/**
 * The way from a per-query memory failure to the node's own limit: a link
 * for system administrators once the source's shard is known, nothing for
 * anyone else.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSourceCapacity, permissionFn } = vi.hoisted(() => ({
    getSourceCapacity: vi.fn(),
    permissionFn: vi.fn(),
}))
vi.mock('@/store/auth', () => ({ usePermission: (perm: string) => permissionFn(perm) }))
vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return { ...actual, aggregationService: { ...actual.aggregationService, getSourceCapacity } }
})

import { RaisePerQueryLimitLink } from './RaisePerQueryLimitLink'

const GB = 2 ** 30

function doc(shard: Record<string, unknown>) {
    return {
        source: { dataSourceId: 'ds1', edgeCount: 10, bytesPerEdge: 512, bytesPerEdgeSource: 'default', footprintBytes: 5120 },
        shard: {
            endpoint: '10.0.0.1:6379', used: 2 * GB, maxmemory: 6 * GB, measurable: true, usedPct: 33, reservePct: 20,
            governedBy: 'shard', staticCap: 25_000_000, queryMemCapacity: 512 * 2 ** 20, sources: [], ...shard,
        },
        limits: {
            shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
            maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
            estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
        },
        fullDetail: { verdict: 'unknown', marginPct: 25 },
        auto: { neverRefused: true, cubeCeiling: 8_000_000, fallback: 'diagonal' },
        measuredAt: 'x',
    }
}

function renderLink() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><RaisePerQueryLimitLink dataSourceId="ds1" /></MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
})

describe('RaisePerQueryLimitLink', () => {
    it('links a system administrator to the node’s limits, endpoint encoded, with the ceiling in force', async () => {
        getSourceCapacity.mockResolvedValue(doc({}))
        renderLink()
        const link = await screen.findByTestId('raise-per-query-limit')
        expect(link).toHaveAttribute('href', '/admin/infrastructure?limits=10.0.0.1%3A6379')
        expect(link).toHaveTextContent(/Raise the per-query limit on 10\.0\.0\.1:6379\s*\(now 512 MB\)/)
    })

    it('renders nothing for a non-admin, and never asks for the capacity', async () => {
        permissionFn.mockReturnValue(false)
        renderLink()
        await waitFor(() => expect(getSourceCapacity).not.toHaveBeenCalled())
        expect(screen.queryByTestId('raise-per-query-limit')).not.toBeInTheDocument()
    })

    it('renders nothing while the shard is unknown', async () => {
        getSourceCapacity.mockResolvedValue(doc({ endpoint: 'unknown', measurable: false }))
        renderLink()
        await waitFor(() => expect(getSourceCapacity).toHaveBeenCalled())
        expect(screen.queryByTestId('raise-per-query-limit')).not.toBeInTheDocument()
    })
})
