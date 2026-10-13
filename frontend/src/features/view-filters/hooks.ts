/**
 * React Query hooks for the view filters' counts and activity. Keys sit under
 * `['views', …]` so `invalidateViewAggregates` refreshes them after an edit.
 */
import { useMemo } from 'react'
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { ViewFilterParams } from '@/services/viewApiService'
import { getViewCount, getViewHistogram } from './api'
import { DATE_PRESETS, addDays, localMidnight, ruleDays } from './dateFilter'
import { daysBetween, foldHistogram, grainFor, type HistogramGrain } from './foldHistogram'
import type { DateField, ViewFilterState } from './model'
import { resolveFilters, toQueryParams, type ResolveContext } from './params'

/** How far back the calendar's shading and the day-summed preset counts reach. */
export const ACTIVITY_DAYS = 90

/** How many views a filter set leaves. */
export function useViewCount(params: ViewFilterParams, enabled = true) {
  const key = JSON.stringify(params)
  return useQuery({
    queryKey: ['views', 'count', key],
    queryFn: ({ signal }) => getViewCount(params, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** Views made or changed per bucket over a window, for the given filters. */
export function useViewHistogram(
  window: { field: DateField; after: string; before: string; grain: HistogramGrain },
  params: ViewFilterParams,
  enabled = true,
) {
  // Debounced like the facets, so typing a search makes one request, not one a key.
  const key = useDebouncedValue(JSON.stringify({ window, params }), 150)
  return useQuery({
    queryKey: ['views', 'histogram', key],
    queryFn: ({ signal }) => {
      const { window: w, params: p } = JSON.parse(key) as { window: typeof window; params: ViewFilterParams }
      return getViewHistogram(w, p, signal)
    },
    enabled,
    staleTime: 60_000,
    // The previous picture stays (dimmed) while the next loads — the frame
    // never jumps to a skeleton on a filter change.
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** The filters with one date field's rule taken out — what each choice for that
 *  field is counted against, since a choice replaces the rule. */
function paramsWithout(state: ViewFilterState, ctx: ResolveContext, field: DateField): ViewFilterParams {
  return toQueryParams(resolveFilters({ ...state, [field]: null }, ctx))
}

/**
 * Views per local day over the past `ACTIVITY_DAYS` days, for one date field,
 * counted with every filter except that field's own rule — so the calendar shows
 * the whole window to choose from.
 */
export function useDayActivity(state: ViewFilterState, ctx: ResolveContext, field: DateField, enabled = true) {
  const params = useMemo(() => paramsWithout(state, ctx, field), [state, ctx, field])
  const days = useMemo(() => daysBetween(addDays(ctx.today, -(ACTIVITY_DAYS - 1)), ctx.today), [ctx.today])
  const window = useMemo(() => ({
    field,
    after: localMidnight(days[0]).toISOString(),
    before: localMidnight(addDays(ctx.today, 1)).toISOString(),
    grain: grainFor(),
  }), [field, days, ctx.today])
  const histogram = useViewHistogram(window, params, enabled)
  const counts = useMemo(() => foldHistogram(histogram.data?.buckets ?? []), [histogram.data])
  return { days, counts, histogram }
}

/**
 * What the Date menu shows beside its choices for one field: each preset's count,
 * and each day's for the calendar's shading. Presets inside the activity window are
 * summed from it; older ones (last quarter, this year) cost one count each, asked
 * only while the menu is open.
 */
export function useDateCounts(state: ViewFilterState, ctx: ResolveContext, field: DateField, enabled: boolean) {
  const activity = useDayActivity(state, ctx, field, enabled)
  const ready = Boolean(activity.histogram.data) && !activity.histogram.isPlaceholderData
  const start = activity.days[0]
  const older = DATE_PRESETS.filter(p => (ruleDays(p.rule, ctx.today)?.from ?? '') < start)
  const olderCounts = useQueries({
    queries: older.map(p => {
      const params = toQueryParams(resolveFilters({ ...state, [field]: p.rule }, ctx))
      return {
        queryKey: ['views', 'count', JSON.stringify(params)],
        queryFn: ({ signal }: { signal: AbortSignal }) => getViewCount(params, signal),
        enabled,
        staleTime: 30_000,
        retry: false,
      }
    }),
  })

  const presetCount = (rule: string): number | undefined => {
    const i = older.findIndex(p => p.rule === rule)
    if (i >= 0) return olderCounts[i]?.data?.total
    const span = ruleDays(rule, ctx.today)
    if (!ready || !span) return undefined
    let sum = 0
    for (const [day, n] of activity.counts) {
      if ((!span.from || day >= span.from) && (!span.to || day <= span.to)) sum += n
    }
    return sum
  }
  return { presetCount, dayCounts: ready ? activity.counts : null }
}
