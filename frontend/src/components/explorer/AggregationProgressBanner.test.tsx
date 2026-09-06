/**
 * The drift banner is where most people meet an operator hold.
 *
 * Its warning is terminal by design — the poll stops once a source reads
 * ready-with-drift, because only a rebuild clears it — so under a hold it is a
 * warning that never goes away and never says why. These tests pin the two
 * things that make it actionable instead: it names the hold, and it keeps
 * offering the one rebuild a hold never refuses, the one a person asks for.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getReadiness } = vi.hoisted(() => ({ getReadiness: vi.fn() }))

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getReadiness },
    }
})

vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { AggregationProgressBanner } from './AggregationProgressBanner'

/** Ready, but the graph moved underneath it — the state the banner exists for. */
const DRIFTING = {
    dataSourceId: 'ds-1',
    isReady: true,
    aggregationStatus: 'ready',
    canCreateViews: true,
    driftDetected: true,
    aggregationEdgeCount: 500,
}

function renderBanner() {
    return render(
        <AggregationProgressBanner
            workspaceId="ws-1"
            dataSourceId="ds-1"
            onStatusChange={() => {}}
        />,
    )
}

describe('AggregationProgressBanner under a hold', () => {
    beforeEach(() => vi.clearAllMocks())

    it('says nothing about automation when nothing is holding the source', async () => {
        getReadiness.mockResolvedValue(DRIFTING)
        renderBanner()

        expect(await screen.findByText(/may be out of date/)).toBeInTheDocument()
        expect(screen.queryByText(/Automatic rebuilds are/)).not.toBeInTheDocument()
    })

    it('names a fleet stop and both ways out, because nothing else will clear this', async () => {
        getReadiness.mockResolvedValue({ ...DRIFTING, heldBy: 'fleet', heldKind: 'stopped' })
        renderBanner()

        expect(await screen.findByText(/Automatic rebuilds are off for every source/)).toBeInTheDocument()
        expect(screen.getByText(/Re-aggregate still works/)).toBeInTheDocument()
        // The button a hold never refuses: a person is not automation.
        expect(screen.getByRole('button', { name: 'Re-aggregate' })).toBeInTheDocument()
    })

    it('calls a timed pause a pause, and names the scope holding it', async () => {
        getReadiness.mockResolvedValue({
            ...DRIFTING, heldBy: 'source', heldKind: 'paused',
            heldUntil: new Date(Date.now() + 3 * 3600_000).toISOString(),
        })
        renderBanner()

        expect(await screen.findByText(/Automatic rebuilds are paused for this source/)).toBeInTheDocument()
    })
})
