/**
 * Activity-ledger hooks.
 *
 * The scope and the whole selection are in every query key, as the query
 * string the server receives: two equal selections share one cache entry, and
 * flipping back to one already seen is instant. `placeholderData` holds the
 * previous answer on screen while a new selection loads, so the page fades
 * rather than collapsing into skeletons.
 */
import { useMemo } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'

import {
    activityQueryString,
    activityService,
    type ActivityEvent,
    type ActivityQuery,
    type ActivityScope,
    type LedgerHealth,
} from '@/services/activityService'

/** The summary is cached for a minute server-side; asking sooner gains nothing. */
const SUMMARY_STALE_MS = 60_000
/** How often "N new" asks. Paused while the tab is hidden. */
export const NEWER_POLL_MS = 15_000

function scopeKey(scope: ActivityScope): string {
    if (scope.kind === 'platform') return 'platform'
    return `${scope.asAuditor ? 'audit' : 'ws'}:${scope.workspaceId}`
}

export const ACTIVITY_KEYS = {
    all: ['activity'] as const,
    scope: (scope: ActivityScope) => ['activity', scopeKey(scope)] as const,
    events: (scope: ActivityScope, qs: string) => ['activity', scopeKey(scope), 'events', qs] as const,
    newer: (scope: ActivityScope, qs: string, since: string | null) =>
        ['activity', scopeKey(scope), 'newer', qs, since] as const,
    summary: (scope: ActivityScope, qs: string) => ['activity', scopeKey(scope), 'summary', qs] as const,
    catalogue: (scope: ActivityScope) => ['activity', scopeKey(scope), 'catalogue'] as const,
    event: (scope: ActivityScope, id: string | null) => ['activity', scopeKey(scope), 'event', id] as const,
}

/** The timeline: pages of events, newest first. */
export function useActivityEvents(scope: ActivityScope, query: ActivityQuery) {
    const qs = activityQueryString(scope, query)
    const result = useInfiniteQuery({
        queryKey: ACTIVITY_KEYS.events(scope, qs),
        queryFn: ({ pageParam }) => activityService.listEvents(scope, query, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        staleTime: 15_000,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    const events = useMemo<ActivityEvent[]>(() => {
        // A page boundary can repeat an event that arrived mid-scroll; the
        // keyset cursor already prevents it, this keeps a repeat harmless.
        const seen = new Set<string>()
        const out: ActivityEvent[] = []
        for (const page of result.data?.pages ?? []) {
            for (const e of page.events) {
                if (!seen.has(e.id)) {
                    seen.add(e.id)
                    out.push(e)
                }
            }
        }
        return out
    }, [result.data])
    // The ledger's health rides on the first page only.
    const ledger: LedgerHealth | null = result.data?.pages[0]?.ledger ?? null
    return {
        events,
        ledger,
        isLoading: result.isLoading,
        isFetching: result.isFetching,
        isPlaceholderData: result.isPlaceholderData,
        error: result.error as Error | null,
        hasNextPage: !!result.hasNextPage,
        isFetchingNextPage: result.isFetchingNextPage,
        fetchNextPage: result.fetchNextPage,
        refetch: result.refetch,
    }
}

/**
 * How many matching events arrived after the page was loaded. Off while the
 * ledger is importing history — those events are old, not new — and while
 * the tab is hidden (React Query does not poll a background tab).
 */
export function useActivityNewer(
    scope: ActivityScope, query: ActivityQuery, since: string | null, enabled: boolean,
) {
    const qs = activityQueryString(scope, query)
    return useQuery({
        queryKey: ACTIVITY_KEYS.newer(scope, qs, since),
        queryFn: () => activityService.countNewer(scope, query, since as string),
        enabled: enabled && !!since,
        refetchInterval: NEWER_POLL_MS,
        refetchOnWindowFocus: true,
        staleTime: 0,
        retry: false,
    })
}

export function useActivitySummary(scope: ActivityScope, query: ActivityQuery) {
    const qs = activityQueryString(scope, { ...query, q: undefined })
    return useQuery({
        queryKey: ACTIVITY_KEYS.summary(scope, qs),
        queryFn: () => activityService.getSummary(scope, query),
        staleTime: SUMMARY_STALE_MS,
        placeholderData: (prev) => prev,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}

export function useActivityCatalogue(scope: ActivityScope) {
    return useQuery({
        queryKey: ACTIVITY_KEYS.catalogue(scope),
        queryFn: () => activityService.getCatalogue(scope),
        // The catalogue changes with a deploy, not with use.
        staleTime: 60 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}

export function useActivityEvent(scope: ActivityScope, eventId: string | null) {
    return useQuery({
        queryKey: ACTIVITY_KEYS.event(scope, eventId),
        queryFn: () => activityService.getEvent(scope, eventId as string),
        enabled: !!eventId,
        staleTime: 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}
