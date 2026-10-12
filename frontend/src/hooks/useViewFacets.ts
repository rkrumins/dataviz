/**
 * useViewFacets — fetches the Explorer's filter-dropdown source data.
 *
 * Backed by React Query so every consumer (Tag dropdown, ViewType
 * dropdown, Creator dropdown) shares one cache entry instead of firing
 * its own request. A 60-second stale time means the dropdowns update
 * soon after new views are added without hammering the endpoint.
 *
 * The backend returns GLOBAL facets (unscoped by other active filters)
 * so users can always pick from the full set of values — this matches
 * discovery-picker UX where the dropdown is a menu of possibilities,
 * not a query refinement.
 */
import { useQuery } from '@tanstack/react-query'
import {
  getViewFacets,
  type ViewFacetsResponse,
  type ViewFilterParams,
} from '@/services/viewApiService'

const EMPTY_FACETS: ViewFacetsResponse = {
  tags: [],
  viewTypes: [],
  creators: [],
}

const FACETS_QUERY_KEY = ['views', 'facets'] as const

/**
 * ``params`` narrows the facets to a filter set — the workspace Views tab passes
 * its workspace, so its People list names this workspace's people only. Without
 * params it is the catalogue-wide set, on the original key so existing callers
 * keep sharing one cache entry.
 */
export function useViewFacets(params?: ViewFilterParams) {
  const query = useQuery({
    queryKey: params ? [...FACETS_QUERY_KEY, JSON.stringify(params)] : FACETS_QUERY_KEY,
    queryFn: () => getViewFacets(params),
    staleTime: 60_000,
  })

  return {
    facets: query.data ?? EMPTY_FACETS,
    isLoading: query.isLoading,
    error: query.error,
  }
}
