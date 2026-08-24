/**
 * React Query over the profiling API.
 *
 * The `insights-` key prefix is load-bearing: `useBackendRecovery` invalidates
 * on it, so these recover with the rest of the Ingestion surface when the
 * backend comes back.
 *
 * **Query keys hold the window TOKEN, never a resolved range.** This is the
 * durable fix for the card that sat on "Loading history…" forever: the range
 * used to be computed client-side from `new Date()`, which put a new value in
 * the key on every render, which started a new pending query, which caused
 * another render. Freezing it at mount stopped the loop but pinned the window's
 * right edge to whenever the component happened to mount, so a drawer left
 * open could never pick up a newer snapshot. A token is stable across renders
 * AND moves with time, because the server resolves it.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { profilingService, type SeriesQuery } from '@/services/profilingService'
import type {
    BoardPayload,
    FindingsPayload,
    ObservationsPayload,
    ProfilingPolicy,
    SeriesPayload,
} from '@/types/profiling'

export const PROFILING_KEY = 'insights-profiling' as const

/** Named windows the UI offers. `days` is only for display maths — the
 *  request sends the key and the server resolves it. */
export const PROFILING_WINDOWS = [
    { key: '24h', label: '24 hours', days: 1 },
    { key: '7d', label: '7 days', days: 7 },
    { key: '30d', label: '30 days', days: 30 },
    { key: '90d', label: '90 days', days: 90 },
] as const

export type ProfilingWindowKey = (typeof PROFILING_WINDOWS)[number]['key']
/**
 * Where a surface opens.
 *
 * SEVEN DAYS, not thirty. Three reasons, in order of weight:
 *
 *  - It sits inside raw retention, so the default view is full fidelity with
 *    no bucketing — the only window that is both wide enough to show a rhythm
 *    and fine enough to show a minute.
 *  - It covers a weekly cycle. Nightly loads, weekday-only pipelines and
 *    weekend gaps are all invisible in 24 hours and diluted in 30 days.
 *  - "What moved" is a recency question. A source that shifted three weeks ago
 *    is history, not news, and at 30 days it outranks something that moved
 *    this morning.
 *
 * 24 hours is one click away for an incident, and 30/90 for an audit.
 */
export const DEFAULT_WINDOW: ProfilingWindowKey = '7d'

/**
 * Cadence, and why it is this lazy.
 *
 * Snapshots are durable rows whose newest member arrives at the capture
 * cadence — 60s at the very fastest, and only when something actually changed.
 * Polling a 30-day window every few seconds to maybe gain one point at the
 * right edge is pure waste. Refetch on focus covers "I came back to this tab".
 */
const CADENCE = {
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: 800,
} as const

export function useProfilingSeries(
    query: SeriesQuery,
    options: { enabled?: boolean } = {},
): UseQueryResult<SeriesPayload, Error> {
    const enabled = (options.enabled ?? true)
        && (query.scope === 'all' || Boolean(query.id))
    return useQuery<SeriesPayload, Error>({
        queryKey: [
            PROFILING_KEY, 'series', query.scope, query.id ?? null,
            query.window ?? DEFAULT_WINDOW, query.from ?? null, query.to ?? null,
            query.grain ?? 'auto', query.metric ?? 'total',
            query.breakdown ?? 'none', query.top ?? null, query.compare ?? false,
        ],
        queryFn: ({ signal }) => profilingService.getSeries(query, signal),
        enabled,
        ...CADENCE,
    })
}

export function useProfilingBoard(
    query: Parameters<typeof profilingService.getBoard>[0],
    options: { enabled?: boolean } = {},
): UseQueryResult<BoardPayload, Error> {
    return useQuery<BoardPayload, Error>({
        queryKey: [
            PROFILING_KEY, 'board', query.window ?? DEFAULT_WINDOW,
            query.workspaceId ?? null, query.providerId ?? null,
            query.metric ?? 'nodes', query.unusualOnly ?? false,
            query.limit ?? null, query.offset ?? 0,
        ],
        queryFn: ({ signal }) => profilingService.getBoard(query, signal),
        enabled: options.enabled ?? true,
        ...CADENCE,
    })
}

export function useProfilingObservations(
    query: Parameters<typeof profilingService.getObservations>[0],
    options: { enabled?: boolean } = {},
): UseQueryResult<ObservationsPayload, Error> {
    return useQuery<ObservationsPayload, Error>({
        queryKey: [
            PROFILING_KEY, 'observations', query.id,
            query.window ?? DEFAULT_WINDOW, query.onlyNotable ?? false,
            query.limit ?? null, query.offset ?? 0,
        ],
        queryFn: ({ signal }) => profilingService.getObservations(query, signal),
        enabled: (options.enabled ?? true) && Boolean(query.id),
        ...CADENCE,
    })
}

export function useProfilingFindings(
    query: Parameters<typeof profilingService.getFindings>[0] = {},
    options: { enabled?: boolean } = {},
): UseQueryResult<FindingsPayload, Error> {
    return useQuery<FindingsPayload, Error>({
        queryKey: [
            PROFILING_KEY, 'findings', query.id ?? null,
            query.openOnly ?? false, query.limit ?? null, query.offset ?? 0,
        ],
        queryFn: ({ signal }) => profilingService.getFindings(query, signal),
        enabled: options.enabled ?? true,
        // Findings are the one read worth seeing promptly — it is the surface
        // telling you something rather than you asking it.
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: 1,
        retryDelay: 800,
    })
}

export function useProfilingPolicy(
    options: { enabled?: boolean } = {},
): UseQueryResult<ProfilingPolicy, Error> {
    return useQuery<ProfilingPolicy, Error>({
        queryKey: [PROFILING_KEY, 'policy'],
        queryFn: ({ signal }) => profilingService.getPolicy(signal),
        enabled: options.enabled ?? true,
        staleTime: 10 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: 1,
    })
}
