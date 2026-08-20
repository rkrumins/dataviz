/**
 * useCountHistory / useProviderHistory — React Query over the persisted
 * counts history.
 *
 * The `insights-` key prefix is load-bearing: `useBackendRecovery` invalidates
 * on it, so these queries recover with the rest of the insights surface when
 * the backend comes back.
 *
 * Cadence is deliberately much lazier than `useAssetStats`. That hook polls
 * because a cache row it is watching may be recomputed at any moment; this one
 * reads durable rows whose newest member arrives at the capture cadence
 * (60s at the very fastest, and only when something actually changed). Polling
 * a 30-day window every few seconds to maybe gain one point at the right edge
 * would be pure waste — so it refetches on focus and otherwise sits still.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
    insightsHistoryService,
    type HistoryGrain,
} from '@/services/insightsHistoryService'
import type {
    CountHistoryPayload,
    Envelope,
    ProviderHistoryPayload,
} from '@/types/insights'

export const COUNT_HISTORY_QUERY_KEY_PREFIX = 'insights-history' as const
export const PROVIDER_HISTORY_QUERY_KEY_PREFIX = 'insights-history-provider' as const
export const FLEET_HISTORY_QUERY_KEY_PREFIX = 'insights-history-fleet' as const

/** Named windows. `label` is what the segmented control shows; `days` drives
 *  the request. Kept here rather than in the component so the page, the card
 *  and the tests all agree on what "30d" means. */
export const HISTORY_WINDOWS = [
    { key: '24h', label: '24h', days: 1 },
    { key: '7d', label: '7d', days: 7 },
    { key: '30d', label: '30d', days: 30 },
    { key: '90d', label: '90d', days: 90 },
] as const

export type HistoryWindowKey = (typeof HISTORY_WINDOWS)[number]['key'] | 'custom'

export const DEFAULT_HISTORY_WINDOW: HistoryWindowKey = '30d'

/**
 * Resolve a window key (plus optional explicit bounds) to an ISO range.
 *
 * Pure and exported so the range arithmetic is testable without a live
 * QueryClient — and so the "custom range with only one end filled in" case has
 * exactly one definition. A custom range missing an end is completed from the
 * other end rather than rejected: a half-filled date picker should narrow the
 * view, not blank it.
 */
export function resolveWindow(
    windowKey: HistoryWindowKey,
    custom?: { from?: string; to?: string },
    now: Date = new Date(),
): { from: string; to: string } {
    if (windowKey === 'custom' && (custom?.from || custom?.to)) {
        const to = custom?.to ? new Date(`${custom.to}T23:59:59.999Z`) : now
        const from = custom?.from
            ? new Date(`${custom.from}T00:00:00.000Z`)
            : new Date(to.getTime() - 30 * 86_400_000)
        return { from: from.toISOString(), to: to.toISOString() }
    }
    const days =
        HISTORY_WINDOWS.find((w) => w.key === windowKey)?.days ?? 30
    return {
        from: new Date(now.getTime() - days * 86_400_000).toISOString(),
        to: now.toISOString(),
    }
}

interface UseHistoryOptions {
    enabled?: boolean
    grain?: HistoryGrain
}

export function useCountHistory(
    dataSourceId: string | null | undefined,
    range: { from: string; to: string },
    { enabled = true, grain = 'auto' }: UseHistoryOptions = {},
): UseQueryResult<Envelope<CountHistoryPayload>, Error> {
    return useQuery<Envelope<CountHistoryPayload>, Error>({
        queryKey: [
            COUNT_HISTORY_QUERY_KEY_PREFIX, dataSourceId, range.from, range.to, grain,
        ],
        queryFn: ({ signal }) =>
            insightsHistoryService.getDataSourceHistory(
                dataSourceId!, { from: range.from, to: range.to, grain }, signal,
            ),
        enabled: enabled && Boolean(dataSourceId),
        // Five minutes: the capture cadence floor is 60s and a changed
        // snapshot is not urgent to see. Refetch-on-focus covers "I came back
        // to this tab and want the current picture".
        staleTime: 5 * 60 * 1000,
        gcTime: 15 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: 1,
        retryDelay: 800,
    })
}

/** Platform-wide totals — the altitude above per-provider. It is the only
 *  view that can show a source falling off the platform entirely, because
 *  every narrower scope is filtered by something that source no longer has. */
export function useFleetHistory(
    range: { from: string; to: string },
    { enabled = true, grain = 'auto' }: UseHistoryOptions = {},
): UseQueryResult<Envelope<ProviderHistoryPayload>, Error> {
    return useQuery<Envelope<ProviderHistoryPayload>, Error>({
        queryKey: [FLEET_HISTORY_QUERY_KEY_PREFIX, range.from, range.to, grain],
        queryFn: ({ signal }) =>
            insightsHistoryService.getFleetHistory(
                { from: range.from, to: range.to, grain }, signal,
            ),
        enabled,
        staleTime: 5 * 60 * 1000,
        gcTime: 15 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: 1,
        retryDelay: 800,
    })
}

export function useProviderHistory(
    providerId: string | null | undefined,
    range: { from: string; to: string },
    { enabled = true, grain = 'auto' }: UseHistoryOptions = {},
): UseQueryResult<Envelope<ProviderHistoryPayload>, Error> {
    return useQuery<Envelope<ProviderHistoryPayload>, Error>({
        queryKey: [
            PROVIDER_HISTORY_QUERY_KEY_PREFIX, providerId, range.from, range.to, grain,
        ],
        queryFn: ({ signal }) =>
            insightsHistoryService.getProviderHistory(
                providerId!, { from: range.from, to: range.to, grain }, signal,
            ),
        enabled: enabled && Boolean(providerId),
        staleTime: 5 * 60 * 1000,
        gcTime: 15 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: 1,
        retryDelay: 800,
    })
}
