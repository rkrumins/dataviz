/**
 * Saved filters — a person's named Explorer filter sets, kept on the server so they
 * follow them to any browser.
 *
 * `query` is the Explorer's own address query in its canonical spelling (see
 * `canonicalFilterQuery`), so applying one is writing it back to the address, and
 * the server never has to understand it.
 */
import { authFetch } from './apiClient'

export interface SavedViewFilter {
  id: string
  name: string
  query: string
  position: number
  createdAt: string
  updatedAt: string
}

const BASE = '/api/v1/views/saved-filters'

export function listSavedViewFilters(): Promise<SavedViewFilter[]> {
  return authFetch<SavedViewFilter[]>(BASE)
}

export function createSavedViewFilter(body: { name: string; query: string }): Promise<SavedViewFilter> {
  return authFetch<SavedViewFilter>(BASE, { method: 'POST', body: JSON.stringify(body) })
}

export function updateSavedViewFilter(
  id: string, body: { name?: string; query?: string },
): Promise<SavedViewFilter> {
  return authFetch<SavedViewFilter>(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(body),
  })
}

export function reorderSavedViewFilters(ids: string[]): Promise<SavedViewFilter[]> {
  return authFetch<SavedViewFilter[]>(`${BASE}/order`, { method: 'PUT', body: JSON.stringify({ ids }) })
}

export function deleteSavedViewFilter(id: string): Promise<void> {
  return authFetch<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
