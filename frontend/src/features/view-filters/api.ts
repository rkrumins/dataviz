/**
 * The view filters' own reads. A count takes the same filter params as the list,
 * through the one shared serializer, so it can never describe a different
 * population from the list it sits beside.
 */
import { authFetch } from '@/services/apiClient'
import { appendViewQuery, type ViewFilterParams } from '@/services/viewApiService'

export function getViewCount(params: ViewFilterParams, signal?: AbortSignal): Promise<{ total: number }> {
  const sp = new URLSearchParams()
  appendViewQuery(sp, params)
  const qs = sp.toString()
  return authFetch<{ total: number }>(`/api/v1/views/count${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined)
}
