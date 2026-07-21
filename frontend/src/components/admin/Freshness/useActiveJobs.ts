/**
 * useActiveJobs — every in-flight aggregation job in ONE polled query,
 * indexed by data source, so the Freshness table can show a live phase and
 * percentage per row.
 *
 * NOT one stream per row: ``JobRow`` opens an SSE connection per active
 * row, and HTTP/1.1 caps a browser at ~6 connections per host — with 20+
 * rebuilding rows that starves the page. A badge does not need per-second
 * fidelity, so the fleet's own 30s cadence is enough.
 *
 * This is a SECONDARY signal. If it fails, 403s, or is capped, rows fall
 * back to the plain "Recomputing" badge — the cockpit must never break, and
 * must never show a phase it cannot substantiate.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { aggregationService, type AggregationJobResponse } from '@/services/aggregationService'

/** One generous page. Past this we stop claiming to know a row's phase
 *  rather than showing a stale one. */
export const ACTIVE_JOB_CAP = 200

/** Matches the fleet query's cadence (useFreshness FLEET_POLL_MS). */
const ACTIVE_JOBS_POLL_MS = 30_000

export const ACTIVE_JOBS_KEY = ['freshness', 'activeJobs'] as const

export interface ActiveJobs {
    /** dataSourceId → its in-flight job. Empty when unavailable. */
    byDataSource: Map<string, AggregationJobResponse>
    /** More in-flight jobs exist than were returned; un-joined rows must
     *  fall back to the plain badge. */
    truncated: boolean
}

export function useActiveJobs(enabled = true): ActiveJobs {
    const { data } = useQuery({
        queryKey: ACTIVE_JOBS_KEY,
        queryFn: () => aggregationService.listJobsGlobal({
            status: ['running', 'pending'],
            limit: ACTIVE_JOB_CAP,
        }),
        enabled,
        staleTime: 15_000,
        refetchInterval: ACTIVE_JOBS_POLL_MS,
        // Secondary signal: fail fast and stay quiet rather than retrying
        // a 403 for an operator who simply can't read the job table.
        retry: false,
    })

    const truncated = !!data && data.total > data.items.length

    const warned = useRef(false)
    useEffect(() => {
        if (truncated && !warned.current) {
            warned.current = true
            console.warn(
                `[freshness] ${data?.total} active jobs exceed the ${ACTIVE_JOB_CAP} join cap — ` +
                'rows beyond it show no phase rather than a stale one.',
            )
        }
    }, [truncated, data?.total])

    return useMemo(() => ({
        byDataSource: new Map((data?.items ?? []).map(j => [j.dataSourceId, j])),
        truncated,
    }), [data?.items, truncated])
}
