/**
 * The view filters' own reads: how many views a filter set leaves, and when they
 * were made or changed. Both take the same filter params as the list, through the
 * one shared serializer, so a count can never describe a different population
 * from the list it sits beside.
 */
import { authFetch } from '@/services/apiClient'
import { appendViewQuery, type ViewFilterParams } from '@/services/viewApiService'
import type { HistogramBucket, HistogramGrain } from './foldHistogram'
import type { DateField } from './model'

export function getViewCount(params: ViewFilterParams, signal?: AbortSignal): Promise<{ total: number }> {
  const sp = new URLSearchParams()
  appendViewQuery(sp, params)
  const qs = sp.toString()
  return authFetch<{ total: number }>(`/api/v1/views/count${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined)
}

export interface ViewHistogram {
  field: DateField
  grain: HistogramGrain
  after: string
  before: string
  total: number
  buckets: HistogramBucket[]
}

export function getViewHistogram(
  window: { field: DateField; after: string; before: string; grain: HistogramGrain },
  params: ViewFilterParams,
  signal?: AbortSignal,
): Promise<ViewHistogram> {
  const sp = new URLSearchParams({
    field: window.field, after: window.after, before: window.before, grain: window.grain,
  })
  appendViewQuery(sp, params)
  return authFetch<ViewHistogram>(`/api/v1/views/histogram?${sp}`, signal ? { signal } : undefined)
}
