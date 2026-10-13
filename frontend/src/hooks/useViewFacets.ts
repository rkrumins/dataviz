/**
 * useViewFacets — fetches the Explorer's filter-dropdown source data.
 *
 * Backed by React Query so every consumer (Tag dropdown, ViewType
 * dropdown, Creator dropdown) shares one cache entry instead of firing
 * its own request. A 60-second stale time means the dropdowns update
 * soon after new views are added without hammering the endpoint.
 *
 * Called bare, the backend returns GLOBAL facets (unscoped by other active
 * filters) so users can always pick from the full set of values — the menu
 * of possibilities. Called with the active filters, it returns the LIVE
 * counts shown beside those possibilities (see below).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  getViewFacets,
  type ViewFacetField,
  type ViewFacetsResponse,
  type ViewFilterParams,
} from '@/services/viewApiService'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

const EMPTY_FACETS: ViewFacetsResponse = {
  tags: [],
  viewTypes: [],
  creators: [],
}

const FACETS_QUERY_KEY = ['views', 'facets'] as const

/**
 * ``params`` turns the facets LIVE: each dimension counted with the other filters
 * applied, so a menu can say how many views each option would leave. Without
 * params it is the catalogue-wide set (the "universe" the menus take their
 * options from), on the original key so existing callers keep sharing one cache
 * entry. Live params are debounced briefly so a few quick clicks make one
 * request, and the previous counts stay on screen while the next arrive.
 */
export function useViewFacets(
  params?: ViewFilterParams,
  opts: { fields?: ViewFacetField[]; enabled?: boolean } = {},
) {
  const key = params ? JSON.stringify(params) : null
  const debouncedKey = useDebouncedValue(key, 150)
  const fields = opts.fields
  const query = useQuery({
    queryKey: debouncedKey === null
      ? FACETS_QUERY_KEY
      : [...FACETS_QUERY_KEY, debouncedKey, fields?.join(',') ?? ''],
    queryFn: () => getViewFacets(
      debouncedKey === null ? undefined : (JSON.parse(debouncedKey) as ViewFilterParams),
      fields,
    ),
    staleTime: debouncedKey === null ? 60_000 : 30_000,
    placeholderData: debouncedKey === null ? undefined : keepPreviousData,
    enabled: opts.enabled ?? true,
  })

  return {
    facets: query.data ?? EMPTY_FACETS,
    /** True until the first answer for this kind of request arrives. */
    isLoading: query.isLoading,
    /** A newer answer is on its way; what's shown is the previous one. */
    isRefreshing: query.isFetching && (query.isPlaceholderData || key !== debouncedKey),
    error: query.error,
  }
}
