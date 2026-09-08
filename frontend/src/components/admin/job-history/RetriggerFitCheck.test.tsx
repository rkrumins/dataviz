/**
 * The fit check answers before the job is queued, and re-answers as the
 * operator changes the form: Full detail against the last run's estimate,
 * Auto never refused.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSourceCapacity } = vi.hoisted(() => ({ getSourceCapacity: vi.fn() }))

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return { ...actual, aggregationService: { ...actual.aggregationService, getSourceCapacity } }
})

import { RetriggerFitCheck } from './RetriggerFitCheck'

const GB = 2 ** 30

const DOC = {
    source: { dataSourceId: 'ds-1', label: 'Warehouse', edgeCount: 2_000_000, bytesPerEdge: 512, bytesPerEdgeSource: 'default', footprintBytes: 1_024_000_000, lastCubeEstimate: 10_000_000, lastRegime: 'boundary' },
    shard: { endpoint: '10.0.0.1:6379', used: 36 * GB, maxmemory: 40 * GB, measurable: true, usedPct: 90, reservePct: 0, reserveBytes: 0, availableBytes: 4 * GB, allowedGrowthEdges: Math.floor(4 * GB / 512), governedBy: 'shard', staticCap: 25_000_000, sources: [] },
    limits: {
        shardReservePct: { value: 0, source: 'global' }, bytesPerEdge: { value: 512, source: 'default' },
        maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
    },
    fullDetail: { estimateEdges: 10_000_000, estimateSource: 'lastRun', growthEdges: 8_000_000, neededBytes: 8_000_000 * 512, verdict: 'fits', marginPct: 25 },
    auto: { neverRefused: true, cubeCeiling: 8_000_000, wouldStoreCube: false, fallback: 'diagonal' },
    measuredAt: '2026-09-08T10:00:00Z',
}

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    getSourceCapacity.mockResolvedValue(DOC)
})

describe('RetriggerFitCheck', () => {
    it('says Full detail fits at the current limits, with the numbers', async () => {
        wrap(<RetriggerFitCheck dataSourceId="ds-1" draftTuning={{ materializeFinePairs: true }} />)
        const box = await screen.findByTestId('fit-check')
        expect(box).toHaveTextContent('Full detail: fits.')
        expect(box).toHaveTextContent('~8.0M new edges need 3.8 GB')
    })

    it('flips to short when the draft raises the reserve, before anything is queued', async () => {
        // 40 GB × 50% reserve leaves nothing above the 36 GB used.
        wrap(<RetriggerFitCheck dataSourceId="ds-1" draftTuning={{ materializeFinePairs: true, shardReservePct: 50 }} />)
        const box = await screen.findByTestId('fit-check')
        expect(box).toHaveTextContent(/Full detail: short by/)
        expect(box).toHaveTextContent(/Choose Auto/)
    })

    it('names the ceiling when the draft ceiling is what refuses', async () => {
        wrap(<RetriggerFitCheck dataSourceId="ds-1" draftTuning={{ materializeFinePairs: true, maxMaterializedEdges: 5_000_000 }} />)
        expect(await screen.findByTestId('fit-check')).toHaveTextContent('Full detail: over the edge ceiling.')
    })

    it('Auto is never refused, and says what it would store today', async () => {
        wrap(<RetriggerFitCheck dataSourceId="ds-1" draftTuning={{ materializeFinePairs: 'auto' }} />)
        const box = await screen.findByTestId('fit-check')
        expect(box).toHaveTextContent('Auto: this run is never refused.')
        expect(box).toHaveTextContent(/Full detail would fit today/)
    })

    it('inherits the mode the server resolves when the form says nothing', async () => {
        wrap(<RetriggerFitCheck dataSourceId="ds-1" defaultFinePairs="auto" />)
        expect(await screen.findByTestId('fit-check')).toHaveTextContent('Auto: this run is never refused.')
    })

    it('is honest before a first run', async () => {
        getSourceCapacity.mockResolvedValue({
            ...DOC, source: { ...DOC.source, lastCubeEstimate: null, lastRegime: null },
            fullDetail: { verdict: 'unknown', marginPct: 25 }, auto: { ...DOC.auto, wouldStoreCube: null },
        })
        wrap(<RetriggerFitCheck dataSourceId="ds-1" draftTuning={{ materializeFinePairs: true }} />)
        expect(await screen.findByTestId('fit-check')).toHaveTextContent(/unknown until a first rebuild/)
    })
})
