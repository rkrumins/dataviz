/**
 * A row's expanded panel shows a run's settings on demand, and a running row
 * says — from the live stream first — when the rebuild is going slower to
 * fit the graph store.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { useJob } = vi.hoisted(() => ({ useJob: vi.fn() }))
vi.mock('@/hooks/useJob', () => ({ useJob }))

import type { AggregationJobResponse } from '@/services/aggregationService'
import { JobRow } from './JobRow'

const EFFECTIVE = {
    scan_range_width: 200_000, max_pending_pairs: 50_000_000, write_pacing_ratio: 1.0, extract_concurrency: 1,
    stall_timeout_secs: 10_800, max_wall_secs: 86_400, max_retries: 3,
    sources: { scan_range_width: 'job', max_pending_pairs: 'job', write_pacing_ratio: 'job', extract_concurrency: 'job',
               stall_timeout_secs: 'job', max_wall_secs: 'env', max_retries: 'job' },
}

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_row1', dataSourceId: 'ds-1', status: 'completed', triggerSource: 'manual', progress: 100,
        totalEdges: 1000, processedEdges: 1000, createdEdges: 40, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-09-09T10:00:00Z', startedAt: '2026-09-09T10:00:05Z', completedAt: '2026-09-09T10:03:00Z',
        durationSeconds: 175, runStats: { writes: 40, deletes: 0, effective_tuning: EFFECTIVE },
        ...over,
    } as AggregationJobResponse
}

const noop = () => {}

function renderRow(j: AggregationJobResponse, onExtend?: (job: AggregationJobResponse, patch: unknown) => void) {
    return render(
        <table><tbody>
            <JobRow
                job={j} expanded onToggle={noop} onCancel={noop} onResume={noop} onRetrigger={noop}
                onDelete={noop} onPurge={noop} purgeConfirm={null} setPurgeConfirm={noop} actionLoading={false}
                storedGlobal={{ scanRangeWidth: 200_000 }} onExtend={onExtend}
            />
        </tbody></table>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useJob.mockReturnValue({ connected: false, needsResync: false, terminal: false, snapshot: {} })
})

describe('JobRow run settings', () => {
    it('names the profile in the Settings cell and opens the panel on demand', async () => {
        renderRow(job())
        const toggle = screen.getByRole('button', { name: /Balanced/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByTestId('run-settings-panel')).not.toBeInTheDocument()

        await userEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        const panel = screen.getByTestId('run-settings-panel')
        expect(panel).toHaveTextContent('Balanced profile')
        expect(panel).toHaveTextContent('Fleet default')       // scan width equals the stored global
        expect(panel).toHaveTextContent('Nothing — ran at its settings')
    })

    it('shows the narrowing state for a running job from the live stream first', () => {
        useJob.mockReturnValue({
            connected: true, needsResync: false, terminal: false,
            snapshot: { adapted_scan_width: 12_500, adapted_extract_concurrency: 1, adapted_reconcile_strategy: 'keys_only' },
        })
        renderRow(job({
            status: 'running', progress: 60, currentPhase: 'reconciling', completedAt: undefined,
            runStats: { effective_tuning: EFFECTIVE, adapted: { scan_width: 50_000 } },
        }))
        const block = screen.getByTestId('narrowing-state')
        expect(block).toHaveTextContent('Going slower to fit the graph store')
        expect(block).toHaveTextContent('scans narrowed to 12,500 rows')   // live wins over the polled 50,000
        expect(block).toHaveTextContent('reading serially')
        expect(block).toHaveTextContent('keys-only reconcile')
    })

    it('stays quiet on a running job that is running at its settings', () => {
        renderRow(job({ status: 'running', progress: 30, currentPhase: 'extracting', completedAt: undefined }))
        expect(screen.queryByTestId('narrowing-state')).not.toBeInTheDocument()
    })
})

describe('JobRow adjust this run', () => {
    it('offers more time on a running job and sends the exact patch', async () => {
        const onExtend = vi.fn()
        renderRow(job({
            status: 'running', progress: 60, currentPhase: 'reconciling', completedAt: undefined, timeoutSecs: 10_800,
            startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
            lastCheckpointAt: new Date(Date.now() - 30 * 60_000).toISOString(),
            liveOverrides: { history: [{ at: new Date().toISOString(), by: 'ops@example.com', field: 'timeout_secs', from: 7_200, to: 10_800 }] },
        }), onExtend)

        const toggle = screen.getByRole('button', { name: /Adjust this run/ })
        expect(toggle).toHaveTextContent('stall window 3 h')
        expect(toggle).toHaveTextContent('left')
        await userEvent.click(toggle)
        await userEvent.click(screen.getByRole('button', { name: '+3 h' }))
        expect(onExtend).toHaveBeenCalledWith(expect.objectContaining({ id: 'agg_row1' }), { timeoutSecs: 21_600 })

        await userEvent.click(screen.getByRole('button', { name: /Double it/ }))
        expect(onExtend).toHaveBeenLastCalledWith(expect.anything(), { maxWallSecs: 172_800 })

        await userEvent.type(screen.getByLabelText('Scan timeout, seconds'), '120')
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
        expect(onExtend).toHaveBeenLastCalledWith(expect.anything(), { scanTimeoutS: 120 })
        // …and a gentler shape, from the same disclosure.
        await userEvent.click(screen.getByRole('button', { name: 'Pace ×2' }))
        expect(onExtend).toHaveBeenLastCalledWith(expect.anything(), { writePacingRatio: 2 })
        await userEvent.click(screen.getByRole('button', { name: 'Halve scans' }))
        expect(onExtend).toHaveBeenLastCalledWith(expect.anything(), { scanWidth: 100_000 })
        expect(screen.getByText(/ops@example.com raised the stall window 2 h → 3 h/)).toBeInTheDocument()
    })

    it('is absent on a terminal row', () => {
        renderRow(job(), vi.fn())
        expect(screen.queryByRole('button', { name: /Adjust this run/ })).not.toBeInTheDocument()
    })
})
