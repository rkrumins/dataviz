/**
 * "Remove this filter → +34 views": the way out of an empty list.
 *
 * "No views match" with a Clear-all button throws away every filter to undo the
 * one that over-narrowed. Instead, for each active filter, ask how many views
 * there would be WITHOUT that one filter — one cheap count each — and offer the
 * removals best first. A filter whose removal alone still leaves nothing says
 * so, which is also worth knowing.
 *
 * Done here, one count per filter, rather than by the server: the server can't
 * tell the Recent pill from a created date (both arrive as one `createdAfter`),
 * so it couldn't offer to remove them separately.
 */
import { useQueries } from '@tanstack/react-query'
import { getViewCount } from './api'
import { activeDimensions, type DimensionKey, type FilterLookups } from './dimensions'
import type { ViewFilterState } from './model'
import { resolveFilters, toQueryParams, type ResolveContext } from './params'

/** More filters than this and the list stops being a quick way out. */
const MAX_SUGGESTIONS = 6

export interface Relaxation {
  key: DimensionKey
  /** The filter in words, e.g. "Tags: pii, finance". */
  summary: string
  /** Views there would be without it; `undefined` while counting. */
  count: number | undefined
  /** The filters with it removed. */
  next: ViewFilterState
}

export function useRelaxations(
  state: ViewFilterState,
  ctx: ResolveContext,
  lookups: FilterLookups,
  opts: { enabled: boolean; hide?: readonly DimensionKey[] },
): Relaxation[] {
  const candidates = activeDimensions(state, opts.hide).slice(0, MAX_SUGGESTIONS).map(d => {
    const next = d.clear(state)
    return { key: d.key, summary: d.summary(state, lookups), next, params: toQueryParams(resolveFilters(next, ctx)) }
  })
  const counts = useQueries({
    queries: candidates.map(c => ({
      queryKey: ['views', 'count', JSON.stringify(c.params)],
      queryFn: ({ signal }: { signal: AbortSignal }) => getViewCount(c.params, signal),
      enabled: opts.enabled,
      staleTime: 30_000,
      retry: false,
    })),
  })
  return candidates
    .map((c, i) => ({ key: c.key, summary: c.summary, next: c.next, count: counts[i]?.data?.total }))
    // Best way out first; still-counting rows keep their place at the end.
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
}
