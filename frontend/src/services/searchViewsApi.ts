/**
 * searchViewsApi — subset views (`/api/v1/views/from-search`, `/views/{id}/search`,
 * `/views/{id}/subsets`). The contract is `@/types/searchView`; a layer's matches
 * (`POST /{ws}/graph/search/view-feed`) go through the graph provider, like every
 * other graph read.
 */
import type {
  FromSearchRequest,
  SearchViewStatus,
  SearchViewUpdate,
  SubsetList,
} from '@/types/searchView'
import { queryClient } from '@/lib/queryClient'

import { authFetch } from './apiClient'
import type { View } from './viewApiService'

export interface ViewWithSearch {
  view: View
  search: SearchViewStatus
}

/** The query keys of a subset view's status, and of a view's subsets. */
export const SEARCH_VIEW_QUERY_KEY = 'view-search'
export const SUBSETS_QUERY_KEY = 'view-subsets'

const base = (viewId: string) => `/api/v1/views/${encodeURIComponent(viewId)}`

function invalidate(viewId: string) {
  void queryClient.invalidateQueries({ queryKey: [SEARCH_VIEW_QUERY_KEY, viewId] })
  void queryClient.invalidateQueries({ queryKey: ['view', viewId] })
}

/** Make a subset view. `idempotencyKey` makes a retry return the view the first
 *  attempt made, never a second one. */
export async function createFromSearch(body: FromSearchRequest, idempotencyKey: string): Promise<ViewWithSearch> {
  const out = await authFetch<ViewWithSearch>('/api/v1/views/from-search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': idempotencyKey },
  })
  if (body.readIn) void queryClient.invalidateQueries({ queryKey: [SUBSETS_QUERY_KEY, body.readIn] })
  return out
}

/** A subset view's search, its base and the layers it shows. */
export async function getSearchStatus(viewId: string): Promise<SearchViewStatus> {
  return authFetch<SearchViewStatus>(`${base(viewId)}/search`)
}

/** Change the search, or where its layers come from — against the hash it was read at. */
export async function putSearch(viewId: string, body: SearchViewUpdate): Promise<SearchViewStatus> {
  const status = await authFetch<SearchViewStatus>(`${base(viewId)}/search`, {
    method: 'PUT', body: JSON.stringify(body),
  })
  invalidate(viewId)
  return status
}

/** The subset views made from a view: what changing or deleting it reaches. */
export async function listSubsets(viewId: string): Promise<SubsetList> {
  return authFetch<SubsetList>(`${base(viewId)}/subsets`)
}
