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

const { getReadiness, setJobLimits } = vi.hoisted(() => ({ getReadiness: vi.fn(), setJobLimits: vi.fn() }))

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getReadiness, setJobLimits },
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

describe('AggregationProgressBanner while a rebuild runs', () => {
    beforeEach(() => vi.clearAllMocks())

    it('lets the person give the running job more time without cancelling it', async () => {
        const { default: userEvent } = await import('@testing-library/user-event')
        setJobLimits.mockResolvedValue({})
        getReadiness.mockResolvedValue({
            dataSourceId: 'ds-1', isReady: false, aggregationStatus: 'running', canCreateViews: false,
            driftDetected: false, aggregationEdgeCount: 0,
            activeJob: { id: 'agg_9', dataSourceId: 'ds-1', status: 'running', progress: 42, timeoutSecs: 10_800 },
        })
        renderBanner()

        await userEvent.click(await screen.findByRole('button', { name: /Give it more time/ }))
        expect(setJobLimits).toHaveBeenCalledWith('ds-1', 'agg_9', { timeoutSecs: 21_600 })
    })
})

/**
 * `isReady` is `status === 'ready'` and nothing else, so every other settled
 * state fell through to the in-progress branch: a 5s poll that never stopped,
 * on an end-user surface, from backgrounded tabs — under a spinner claiming
 * "we are pre-computing structural hierarchies… view creation is paused until
 * this completes" for a source somebody had just explicitly skipped.
 */
describe('AggregationProgressBanner on a state that will never change', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useRealTimers()
    })

    const settled = (aggregationStatus: string) => ({
        dataSourceId: 'ds-1', isReady: false, aggregationStatus,
        canCreateViews: true, driftDetected: false, aggregationEdgeCount: 0,
    })

    it.each(['none', 'skipped', 'cancelled'])('stops polling on %s', async (status) => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        getReadiness.mockResolvedValue(settled(status))
        renderBanner()

        await vi.waitFor(() => expect(getReadiness).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(30_000)
        expect(getReadiness).toHaveBeenCalledTimes(1)
    })

    it('never claims work is in flight, or that views are blocked, on a skipped source', async () => {
        getReadiness.mockResolvedValue(settled('skipped'))
        renderBanner()

        expect(await screen.findByText(/Aggregation Skipped/)).toBeInTheDocument()
        expect(screen.queryByText(/pre-computing structural hierarchies/)).not.toBeInTheDocument()
        expect(screen.queryByText(/View creation is paused/)).not.toBeInTheDocument()
        expect(screen.getByText(/Views work as normal/)).toBeInTheDocument()
    })

    it('says what "none" and "cancelled" actually mean', async () => {
        getReadiness.mockResolvedValue(settled('none'))
        const { unmount } = renderBanner()
        expect(await screen.findByText(/has not been set up/)).toBeInTheDocument()
        unmount()

        getReadiness.mockResolvedValue(settled('cancelled'))
        renderBanner()
        expect(await screen.findByText(/Nothing is running now/)).toBeInTheDocument()
    })
})
