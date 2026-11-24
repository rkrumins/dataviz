/**
 * People analytics hooks. Same shape as `useAnalytics`: the resolved range is in
 * every key, and `placeholderData` holds the last render while the next loads, so
 * a range change fades the page rather than collapsing it into skeletons.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { rangeKey, type AnalyticsRangeSelection } from '@/services/analyticsService'
import {
    peopleActivityService,
    type FeedKind,
    type PeopleQuery,
} from '@/services/peopleActivityService'
import { httpStatusOf } from '@/services/graphRequestFailure'

const STALE_MS = 60_000

/** A refusal or a miss is an answer, not a blip: asking again changes nothing. */
const retry = (count: number, err: unknown) => {
    const status = httpStatusOf(err)
    return !(status === 403 || status === 404 || status === 422) && count < 1
}

export const PEOPLE_KEYS = {
    all: ['analytics', 'people'] as const,
    roster: (range: AnalyticsRangeSelection, q: PeopleQuery) =>
        ['analytics', 'people', 'roster', rangeKey(range), q] as const,
    person: (id: string, range: AnalyticsRangeSelection, ws?: string | null) =>
        ['analytics', 'people', 'person', id, rangeKey(range), ws ?? null] as const,
    calendar: (id: string, ws?: string | null) =>
        ['analytics', 'people', 'calendar', id, ws ?? null] as const,
    day: (id: string, day: string, ws?: string | null) =>
        ['analytics', 'people', 'day', id, day, ws ?? null] as const,
    feed: (id: string, ws: string | null | undefined, kinds: FeedKind[]) =>
        ['analytics', 'people', 'feed', id, ws ?? null, kinds.join(',')] as const,
    lines: (ids: string[], range: AnalyticsRangeSelection, ws?: string | null) =>
        ['analytics', 'people', 'lines', [...ids].sort().join(','), rangeKey(range), ws ?? null] as const,
    scopeDay: (day: string, ws?: string | null) =>
        ['analytics', 'people', 'scope-day', day, ws ?? null] as const,
}

/** A few people's activity lines on one axis — the compare chart. */
export function usePeopleLines(ids: string[], range: AnalyticsRangeSelection, workspaceId?: string | null) {
    return useQuery({
        queryKey: PEOPLE_KEYS.lines(ids, range, workspaceId),
        queryFn: () => peopleActivityService.lines(ids, range, workspaceId),
        enabled: ids.length > 0,
        staleTime: STALE_MS,
        placeholderData: keepPreviousData,
        retry,
        refetchOnWindowFocus: false,
    })
}

/** Everyone active on one day — the day panel. */
export function useScopeDay(day: string | null, workspaceId?: string | null) {
    return useQuery({
        queryKey: PEOPLE_KEYS.scopeDay(day ?? '', workspaceId),
        queryFn: () => peopleActivityService.scopeDay(day as string, workspaceId),
        enabled: !!day,
        staleTime: STALE_MS,
        retry,
        refetchOnWindowFocus: false,
    })
}

export function usePeopleRoster(range: AnalyticsRangeSelection, query: PeopleQuery, enabled = true) {
    return useQuery({
        queryKey: PEOPLE_KEYS.roster(range, query),
        queryFn: () => peopleActivityService.roster(range, query),
        enabled,
        staleTime: STALE_MS,
        placeholderData: keepPreviousData,
        retry,
        refetchOnWindowFocus: false,
    })
}

export function usePersonActivity(id: string, range: AnalyticsRangeSelection, workspaceId?: string | null) {
    return useQuery({
        queryKey: PEOPLE_KEYS.person(id, range, workspaceId),
        queryFn: () => peopleActivityService.person(id, range, workspaceId),
        staleTime: STALE_MS,
        placeholderData: keepPreviousData,
        retry,
        refetchOnWindowFocus: false,
    })
}

export function usePersonCalendar(id: string, workspaceId?: string | null) {
    return useQuery({
        queryKey: PEOPLE_KEYS.calendar(id, workspaceId),
        queryFn: () => peopleActivityService.calendar(id, workspaceId),
        staleTime: STALE_MS,
        retry,
        refetchOnWindowFocus: false,
    })
}

export function usePersonDay(id: string, day: string | null, workspaceId?: string | null) {
    return useQuery({
        queryKey: PEOPLE_KEYS.day(id, day ?? '', workspaceId),
        queryFn: () => peopleActivityService.day(id, day as string, workspaceId),
        enabled: !!day,
        staleTime: STALE_MS,
        placeholderData: keepPreviousData,
        retry,
        refetchOnWindowFocus: false,
    })
}

export function usePersonFeed(id: string, workspaceId: string | null | undefined, kinds: FeedKind[]) {
    return useInfiniteQuery({
        queryKey: PEOPLE_KEYS.feed(id, workspaceId, kinds),
        queryFn: ({ pageParam }) => peopleActivityService.events(id, {
            workspaceId, kinds, before: pageParam, limit: 50,
        }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next ?? undefined,
        staleTime: 30_000,
        retry,
        refetchOnWindowFocus: false,
    })
}
