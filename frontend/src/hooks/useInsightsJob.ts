/**
 * useInsightsJob — poll an insights-service background job until it
 * completes, then run a refetch callback so the consumer re-reads the
 * underlying cache row.
 *
 * Usage:
 *
 *   const { status } = useInsightsJob(envelope.meta.job_id, envelope.meta.poll_url, {
 *       onComplete: () => refetch(),
 *       enabled: envelope.meta.refreshing,
 *   })
 *
 * Status:
 *  - 'idle'      — no jobId / disabled
 *  - 'running'   — last poll said running; will re-poll
 *  - 'completed' — last poll said completed; onComplete fired, no further polls
 *  - 'unknown'   — Redis unreachable per backend; the hook stops polling
 *  - 'error'     — the poll request failed (network, 500, etc.)
 */
import { useEffect, useRef, useState } from 'react'
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
     * Fired exactly once when the job transitions to `completed`. Use it
     * to invalidate / refetch the underlying data query.
     */
    onComplete?: () => void
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
    const [status, setStatus] = useState<JobStatus>('idle')
    const [error, setError] = useState<string | null>(null)

    // Avoid stale-closure bugs: keep a ref to the latest onComplete so the
    // poll loop calls the freshest version. Same trick as React's docs
    // recommend for "interval that calls a callback".
    const onCompleteRef = useRef(onComplete)
    useEffect(() => {
        onCompleteRef.current = onComplete
    }, [onComplete])

    useEffect(() => {
        if (!enabled || !jobId || !pollUrl) {
            setStatus('idle')
            setError(null)
            return
        }

        let cancelled = false
        setStatus('running')
        setError(null)

        async function poll() {
            try {
                const res = await fetchWithTimeout(pollUrl as string, { method: 'GET' })
                if (!res.ok) {
                    if (cancelled) return
                    setStatus('error')
                    setError(`Job status fetch failed: ${res.status}`)
                    return
                }
                const body = (await res.json()) as JobStatusResponse
                if (cancelled) return
                if (body.status === 'completed') {
                    setStatus('completed')
                    setError(null)
                    onCompleteRef.current?.()
                    return
                }
                if (body.status === 'unknown') {
                    // Backend signals Redis is unavailable; back off rather
                    // than re-poll a known-broken endpoint forever.
                    setStatus('unknown')
                    return
                }
                // Still running — schedule the next tick.
                setStatus('running')
                timeout = window.setTimeout(poll, pollIntervalMs)
            } catch (e: any) {
                if (cancelled) return
                setStatus('error')
                setError(e?.message ?? 'Job status fetch failed')
            }
        }

        let timeout: number | null = window.setTimeout(poll, pollIntervalMs)

        return () => {
            cancelled = true
            if (timeout != null) window.clearTimeout(timeout)
        }
    }, [enabled, jobId, pollUrl, pollIntervalMs])

    return { status, error }
}
