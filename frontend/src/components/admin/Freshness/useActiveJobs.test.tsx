/**
 * ONE query for every in-flight job, joined by data source. Never one
 * stream per row: JobRow opens an SSE connection per active row and the
 * browser caps concurrent connections at ~6, so 20+ rebuilding rows would
 * starve. This is a SECONDARY signal — the table must render without it.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listJobsGlobal } = vi.hoisted(() => ({ listJobsGlobal: vi.fn() }))
vi.mock('@/services/aggregationService', () => ({
    aggregationService: { listJobsGlobal },
}))

import { ACTIVE_JOB_CAP, useActiveJobs } from './useActiveJobs'

function wrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const job = (id: string, dsId: string) => ({
    id, dataSourceId: dsId, status: 'running', triggerSource: 'api', progress: 40,
    totalEdges: 10, processedEdges: 4, createdEdges: 0, batchSize: 1000,
    resumable: false, retryCount: 0, createdAt: new Date().toISOString(),
})

beforeEach(() => vi.clearAllMocks())

describe('useActiveJobs', () => {
    it('asks only for in-flight jobs, capped', async () => {
        listJobsGlobal.mockResolvedValue({ items: [], total: 0, limit: ACTIVE_JOB_CAP, offset: 0 })
        renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(listJobsGlobal).toHaveBeenCalledWith({
            status: ['running', 'pending'],
            limit: ACTIVE_JOB_CAP,
        }))
    })

    it('indexes jobs by data source', async () => {
        listJobsGlobal.mockResolvedValue({
            items: [job('j1', 'ds_a'), job('j2', 'ds_b')], total: 2, limit: ACTIVE_JOB_CAP, offset: 0,
        })
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(result.current.byDataSource.size).toBe(2))
        expect(result.current.byDataSource.get('ds_a')?.id).toBe('j1')
        expect(result.current.truncated).toBe(false)
    })

    it('reports truncation when more jobs exist than were returned', async () => {
        listJobsGlobal.mockResolvedValue({
            items: [job('j1', 'ds_a')], total: 500, limit: ACTIVE_JOB_CAP, offset: 0,
        })
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(result.current.truncated).toBe(true))
    })

    it('degrades to an empty map when the query fails', async () => {
        listJobsGlobal.mockRejectedValue(new Error('403'))
        const { result } = renderHook(() => useActiveJobs(), { wrapper })
        await waitFor(() => expect(listJobsGlobal).toHaveBeenCalled())
        expect(result.current.byDataSource.size).toBe(0)
        expect(result.current.truncated).toBe(false)
    })

    it('does not fetch when disabled', () => {
        renderHook(() => useActiveJobs(false), { wrapper })
        expect(listJobsGlobal).not.toHaveBeenCalled()
    })
})
