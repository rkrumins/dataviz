/**
 * useAdminTelemetry — product-usage rollup for the Admin → Telemetry panel.
 *
 * Backed by React Query so switching the day-window (7 / 30 / 90) caches
 * each window independently and re-selecting a previously viewed window is
 * instant. The window is folded into the query key so every distinct value
 * gets its own cache slot.
 */
import { useQuery } from '@tanstack/react-query'
import {
    telemetryAdminService,
    type TelemetrySummary,
} from '@/services/telemetryAdminService'

export function useAdminTelemetry(days = 30) {
    const query = useQuery({
        queryKey: ['admin', 'telemetry', 'summary', days] as const,
        queryFn: () => telemetryAdminService.getSummary(days),
        // Usage aggregates move slowly; a minute of staleness is plenty and
        // keeps window-toggling from hammering the endpoint.
        staleTime: 60_000,
        // Keep the last window's numbers on screen while the next one loads
        // so toggling doesn't flash the skeleton.
        placeholderData: (prev) => prev,
        retry: 1,
        refetchOnWindowFocus: false,
    })

    return {
        data: query.data as TelemetrySummary | undefined,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}
