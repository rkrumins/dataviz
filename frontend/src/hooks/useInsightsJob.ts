/**
 * useInsightsJob — poll an insights-service background job until it
 * completes, then run a refetch callback so the consumer re-reads the
 * underlying cache row.
 *
 * Built on React Query: ``refetchInterval`` drives the poll cadence,
 * ``retry`` handles transient errors, query-key dedup means N
 * mounted hooks against the same job_id share one network request.
 * The previous implementation used hand-rolled ``setTimeout`` +
 * ``cancelled`` flag + manual exponential backoff (~140 LOC of state
 * machine) — React Query subsumes all of it.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

export type JobStatus = 'idle' | 'running' | 'completed' | 'unknown' | 'error'

interface JobStatusResponse {
    job_id: string
    status: 'running' | 'completed' | 'unknown'
    kind?: string
}

interface UseInsightsJobOptions {
    /** Stop polling and short-circuit when false. */
    enabled?: boolean
    /** Default 2000ms — under the cache freshness window so users don't wait. */
    pollIntervalMs?: number
    /**
     * Fired exactly once per `running → completed` transition. Use it
     * to invalidate / refetch the underlying data query.
     */
    onComplete?: () => void
}

async function fetchJobStatus(pollUrl: string): Promise<JobStatusResponse> {
    const res = await fetchWithTimeout(pollUrl, { method: 'GET' })
    if (!res.ok) {
        throw new Error(`Job status fetch failed: ${res.status}`)
    }
    return res.json()
}

export function useInsightsJob(
    jobId: string | null | undefined,
    pollUrl: string | null | undefined,
    {
        enabled = true,
        pollIntervalMs = 2000,
        onComplete,
    }: UseInsightsJobOptions = {},
): { status: JobStatus; error: string | null } {
    const isEnabled = enabled && !!jobId && !!pollUrl

    const query = useQuery<JobStatusResponse, Error>({
        // jobId is the natural dedup key — N rows polling the same job
        // collapse to one underlying fetch. URL is included so a cache
        // invalidation that swaps the URL reuses neither key.
        queryKey: ['insights-job', jobId, pollUrl],
        queryFn: () => fetchJobStatus(pollUrl as string),
        enabled: isEnabled,
        // Poll at the configured cadence while the backend reports
        // running. Once status flips to `completed` or `unknown` the
        // function returns false and React Query stops polling.
        refetchInterval: (q) => {
            const status = q.state.data?.status
            return status === 'running' ? pollIntervalMs : false
        },
        // 4 transient retries with exponential backoff (capped at 30s)
        // before surfacing the error. React Query handles the timing.
        retry: 4,
        retryDelay: (attempt) =>
            Math.min(30_000, pollIntervalMs * Math.pow(2, attempt)),
        // No window-focus refetch: a tab regaining focus shouldn't
        // re-poll a job whose status we already know. Auto-recovery
        // happens through the parent's invalidation hooks instead.
        refetchOnWindowFocus: false,
    })

    // Fire onComplete once when the polled status transitions to
    // `completed`. React Query's reference-stable data means this only
    // re-runs on a real status change, not on every refetch.
    useEffect(() => {
        if (query.data?.status === 'completed') {
            onComplete?.()
        }
        // We deliberately depend only on the status string so a new
        // onComplete identity (parent re-renders) doesn't refire.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query.data?.status])

    let status: JobStatus = 'idle'
    if (!isEnabled) {
        status = 'idle'
    } else if (query.isError) {
        status = 'error'
    } else if (query.data?.status === 'completed') {
        status = 'completed'
    } else if (query.data?.status === 'unknown') {
        status = 'unknown'
    } else if (query.data?.status === 'running' || query.isFetching) {
        status = 'running'
    }

    return {
        status,
        error: query.error ? query.error.message : null,
    }
}
