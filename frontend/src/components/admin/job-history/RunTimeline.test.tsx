/**
 * A run's life on one line: how long it waited for a worker, how long it
 * worked, how it ended — and, while it runs, how long so far and when it last
 * saved its place.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AggregationJobResponse } from '@/services/aggregationService'
import { RunTimeline } from './RunTimeline'

const NOW = new Date('2026-10-12T12:00:00Z')

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_1', dataSourceId: 'ds-1', status: 'completed', triggerSource: 'manual', progress: 100,
        totalEdges: 10, processedEdges: 10, createdEdges: 10, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-10-12T11:00:00Z', startedAt: '2026-10-12T11:00:12Z', completedAt: '2026-10-12T11:17:15Z',
        ...over,
    } as AggregationJobResponse
}

beforeEach(() => { vi.useFakeTimers({ now: NOW }) })
afterEach(() => { vi.useRealTimers() })

describe('RunTimeline', () => {
    it('says how long a finished run waited and worked, and how it ended', () => {
        render(<RunTimeline job={job()} />)
        const line = screen.getByRole('list', { name: 'Run timeline' })
        expect(line).toHaveTextContent('Created')
        expect(line).toHaveTextContent('waited 12 s')
        expect(line).toHaveTextContent('ran 17 min 3 s')
        expect(line).toHaveTextContent('Completed')
        // Calendar times at each stop — not "1 h ago" three times over.
        expect(line.querySelectorAll('time')).toHaveLength(3)
        expect(line).toHaveTextContent(/\d{1,2}:\d{2}/)
        expect(line).not.toHaveTextContent(/ago/)
    })

    it('names a failure as one', () => {
        render(<RunTimeline job={job({ status: 'failed' })} />)
        expect(screen.getByRole('list', { name: 'Run timeline' })).toHaveTextContent('Failed')
    })

    it('counts a running job up, and shows its last checkpoint', () => {
        render(<RunTimeline job={job({
            status: 'running', completedAt: undefined,
            startedAt: '2026-10-12T11:20:00Z', lastCheckpointAt: '2026-10-12T11:58:00Z',
        })} />)
        const line = screen.getByRole('list', { name: 'Run timeline' })
        expect(line).toHaveTextContent('running 40 min')
        expect(line).toHaveTextContent('Running')
        expect(screen.getByText('Checkpoint 2 min ago')).toBeInTheDocument()
    })

    it('counts a queued job’s wait', () => {
        render(<RunTimeline job={job({
            status: 'pending', startedAt: undefined, completedAt: undefined, createdAt: '2026-10-12T11:55:00Z',
        })} />)
        expect(screen.getByRole('list', { name: 'Run timeline' })).toHaveTextContent('waiting 5 min')
    })
})
