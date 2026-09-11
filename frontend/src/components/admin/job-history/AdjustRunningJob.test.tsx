/**
 * Going gentler on a running job: the shape in force is shown, each
 * one-click change sends the exact patch, live changes are marked and can
 * be cleared, and the history reads in words.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { AdjustRunningJob } from './AdjustRunningJob'

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_1', dataSourceId: 'ds-1', status: 'running', triggerSource: 'manual', progress: 40,
        totalEdges: 100, processedEdges: 40, createdEdges: 0, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-09-09T10:00:00Z', timeoutSecs: 10_800,
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
        lastCheckpointAt: new Date(Date.now() - 600_000).toISOString(),
        ...over,
    } as AggregationJobResponse
}

describe('AdjustRunningJob', () => {
    it('shows the shape in force and sends the gentler patches', async () => {
        const onAdjust = vi.fn()
        render(<AdjustRunningJob job={job({
            runStats: { effective_tuning: { write_pacing_ratio: 1, extract_concurrency: 2, scan_range_width: 200_000 }, adapted: { scan_width: 50_000 } },
        })} onAdjust={onAdjust} busy={false} />)
        await userEvent.click(screen.getByRole('button', { name: /Adjust this run/ }))
        expect(screen.getByTestId('shape-in-force')).toHaveTextContent(/pacing 1× · 2 reads at a time · scans 200,000 rows \(narrowed to 50,000 by the ladder\)/)

        await userEvent.click(screen.getByRole('button', { name: 'Pace ×2' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'agg_1' }), { writePacingRatio: 2 })
        await userEvent.click(screen.getByRole('button', { name: 'Pace ×4' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), { writePacingRatio: 4 })
        await userEvent.click(screen.getByRole('button', { name: 'Serial reads' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), { extractConcurrency: 1 })
        await userEvent.click(screen.getByRole('button', { name: 'Halve scans' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), { scanWidth: 25_000 })
        // Smaller batches: the one control that does less per batch rather
        // than waiting longer between them.
        expect(screen.getByTestId('shape-in-force')).toHaveTextContent(/batches of at most 500 rows in ~1s/)
        await userEvent.click(screen.getByRole('button', { name: 'Smaller batches' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), { writeBatchMax: 250 })
        // Nothing live yet, so there is nothing to go back from.
        expect(screen.getByRole('button', { name: 'Back to settings' })).toBeDisabled()
        // The time controls are still here.
        await userEvent.click(screen.getByRole('button', { name: '+3 h' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), { timeoutSecs: 21_600 })
    })

    it('marks live changes, offers the way back, and reads the history', async () => {
        const onAdjust = vi.fn()
        render(<AdjustRunningJob job={job({
            liveOverrides: {
                write_pacing_ratio: 2, extract_concurrency: 1,
                history: [{ at: new Date().toISOString(), by: 'ops@example.com', field: 'write_pacing_ratio', from: 1, to: 2 }],
            },
        })} onAdjust={onAdjust} busy={false} />)
        const toggle = screen.getByRole('button', { name: /Adjust this run/ })
        expect(toggle).toHaveTextContent('gentler')
        await userEvent.click(toggle)
        expect(screen.getByTestId('shape-in-force')).toHaveTextContent(/pacing 2× \(live\) · serial reads \(live\) · scans 200,000 rows/)
        expect(screen.getByRole('button', { name: 'Serial reads' })).toBeDisabled()
        await userEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
        expect(onAdjust).toHaveBeenLastCalledWith(expect.anything(), {
            reset: ['writePacingRatio', 'extractConcurrency', 'scanWidth', 'replicaAckMin', 'writeBatchMax', 'writeBatchTargetS'],
        })
        expect(screen.getByText(/ops@example.com set the write pacing 1× → 2×/)).toBeInTheDocument()
    })
})
