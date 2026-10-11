/**
 * A run a person started says who and why — on the row, and in full when
 * opened — and a purge confirmed from the row carries the reason given.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { useJob, peopleById } = vi.hoisted(() => ({ useJob: vi.fn(), peopleById: vi.fn() }))
vi.mock('@/hooks/useJob', () => ({ useJob }))
vi.mock('@/services/userDirectoryService', () => ({ peopleById }))

import type { AggregationJobResponse } from '@/services/aggregationService'
import { JobRow } from './JobRow'

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_row1', dataSourceId: 'ds-1', status: 'completed', triggerSource: 'manual', progress: 100,
        totalEdges: 1000, processedEdges: 1000, createdEdges: 40, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-09-09T10:00:00Z', startedAt: '2026-09-09T10:00:05Z', completedAt: '2026-09-09T10:03:00Z',
        durationSeconds: 175,
        ...over,
    } as AggregationJobResponse
}

const noop = () => {}

function renderRow(j: AggregationJobResponse, extra: Partial<Parameters<typeof JobRow>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <table><tbody>
                <JobRow
                    job={j} expanded onToggle={noop} onCancel={noop} onResume={noop} onRetrigger={noop}
                    onDelete={noop} onPurge={noop} purgeConfirm={null} setPurgeConfirm={noop} actionLoading={false}
                    {...extra}
                />
            </tbody></table>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useJob.mockReturnValue({ connected: false, needsResync: false, terminal: false, snapshot: {} })
    peopleById.mockResolvedValue([
        { id: 'usr_ana', displayName: 'Ana Okafor', email: 'ana@example.com', deleted: false },
    ])
})

describe('JobRow — who started a run, and why', () => {
    it('names the person and their reason on the row and in the opened run', async () => {
        renderRow(job({ triggeredBy: 'usr_ana', statedReason: 'Upstream ETL re-ran' }))

        const block = await screen.findByTestId('run-started-by')
        expect(await within(block).findByText('Ana Okafor')).toBeInTheDocument()
        expect(block).toHaveTextContent('Ana Okafor — “Upstream ETL re-ran”')
        // On the row itself, without opening anything.
        expect(screen.getAllByText('Ana Okafor').length).toBeGreaterThan(1)
        expect(screen.getByText('“Upstream ETL re-ran”')).toBeInTheDocument()
        // One lookup for every mention of the same person.
        expect(peopleById).toHaveBeenCalledTimes(1)
        expect(peopleById).toHaveBeenCalledWith(['usr_ana'])
    })

    it('says so when no reason was given, and shows the id when it names nobody', async () => {
        peopleById.mockResolvedValue([])
        renderRow(job({ triggeredBy: 'usr_gone', statedReason: null }))
        const block = await screen.findByTestId('run-started-by')
        expect(block).toHaveTextContent('No reason given')
        expect(within(block).getByText('usr_gone')).toBeInTheDocument()
    })

    it('shows nothing extra for a run nobody started by hand', () => {
        renderRow(job({ triggerSource: 'schedule', triggeredBy: null }))
        expect(screen.queryByTestId('run-started-by')).not.toBeInTheDocument()
        expect(peopleById).not.toHaveBeenCalled()
    })

    it('carries the reason given in the purge confirmation', async () => {
        const onPurge = vi.fn()
        const user = userEvent.setup()
        renderRow(job(), { purgeConfirm: 'agg_row1', onPurge })

        await user.type(screen.getByRole('textbox', { name: /why\?/i }), 'Stored rollups look wrong')
        await user.click(screen.getByRole('button', { name: 'Confirm Purge' }))
        expect(onPurge).toHaveBeenCalledWith(expect.objectContaining({ id: 'agg_row1' }), 'Stored rollups look wrong')
    })
})
