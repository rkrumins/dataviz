/**
 * useExplorerViews — Data fetching hook for the Explorer page.
 *
 * Handles:
 * - API calls with filter params (visibility, workspace, datasource, search, favourites)
 * - Debounced search (300ms)
 * - Client-side sorting (API only sorts by updated_at DESC)
 * - Client-side workspace multi-select filtering (API only accepts single workspaceId)
 * - Optimistic favourite toggles
 * - Popular/trending views
 * - Pagination via limit/offset
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  listViews, listPopularViews, favouriteView, unfavouriteView,
  type View, type ViewListParams,
} from '@/services/viewApiService'

/** Stable JSON key for array deps — prevents infinite re-render loops from new array refs. */
function useStableKey(value: unknown): string {
  const key = JSON.stringify(value)
  const ref = useRef(key)
  if (ref.current !== key) ref.current = key
  return ref.current
}

// ─── Sort Options ───────────────────────────────────────────────────────────

export type SortOption = 'newest' | 'oldest' | 'popular' | 'updated' | 'az' | 'za'

function sortViews(views: View[], sort: SortOption): View[] {
  const sorted = [...views]
  switch (sort) {
    case 'newest':
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    case 'oldest':
      return sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    case 'popular':
      return sorted.sort((a, b) => b.favouriteCount - a.favouriteCount || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    case 'updated':
      return sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    case 'az':
      return sorted.sort((a, b) => a.name.localeCompare(b.name))
    case 'za':
      return sorted.sort((a, b) => b.name.localeCompare(a.name))
    default:
      return sorted
  }
}

// ─── Filter Params ──────────────────────────────────────────────────────────

export interface ExplorerFilters {
  search: string
  visibility: string | null         // 'enterprise' | 'workspace' | 'private' | null (all)
  workspaceIds: string[]            // Multi-select — filtered client-side
  dataSourceId: string | null
  sort: SortOption
  favouritedOnly: boolean
  category: string | null           // 'my-views' | 'my-favourites' | 'recently-added' | 'shared-with-me' | 'needs-attention' | null
  currentUserName: string | null    // For 'my-views' category filtering
  limit: number
  offset: number
}

export interface UseExplorerViewsResult {
  views: View[]
  totalCount: number
  popularViews: View[]
  isLoading: boolean
  error: string | null
  toggleFavourite: (viewId: string) => void
  removeView: (viewId: string) => void
  refetch: () => void
  loadMore: () => void
  hasMore: boolean
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useExplorerViews(filters: ExplorerFilters): UseExplorerViewsResult {
  const [allViews, setAllViews] = useState<View[]>([])
  const [popularViews, setPopularViews] = useState<View[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [displayCount, setDisplayCount] = useState(filters.limit)
  const [refetchKey, setRefetchKey] = useState(0)

  // Debounce search — only make API call after 300ms of no typing
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search)
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(filters.search)
    }, 300)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [filters.search])

  // ─── Fetch views ────────────────────────────────────────────────────

  // Stabilize array deps to prevent infinite loops from new array refs
  const workspaceIdsKey = useStableKey(filters.workspaceIds)
  const stableVisibility = filters.visibility
  const stableDataSourceId = filters.dataSourceId
  const stableFavouritedOnly = filters.favouritedOnly
  const stableCategory = filters.category
  const stableLimit = filters.limit

  useEffect(() => {
    let cancelled = false

    const fetchViews = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const params: ViewListParams = {
          search: debouncedSearch || undefined,
          visibility: stableVisibility || undefined,
          favouritedOnly: stableFavouritedOnly || undefined,
          deletedOnly: stableCategory === 'deleted' || undefined,
        }

        // Single workspace filter can be sent to API; multi-workspace is client-side
        const wsIds: string[] = JSON.parse(workspaceIdsKey)
        if (wsIds.length === 1) {
          params.workspaceId = wsIds[0]
        }

        if (stableDataSourceId) {
          params.dataSourceId = stableDataSourceId
        }

        const [viewsResult, popular] = await Promise.all([
          listViews(params),
          listPopularViews(10),
        ])

        if (!cancelled) {
          setAllViews(viewsResult)
          setPopularViews(popular)
          setDisplayCount(stableLimit)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[useExplorerViews] Failed to load views:', err)
          setError(err instanceof Error ? err.message : 'Failed to load views')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    fetchViews()
    return () => { cancelled = true }
  }, [debouncedSearch, stableVisibility, workspaceIdsKey, stableDataSourceId, stableFavouritedOnly, stableCategory, stableLimit, refetchKey])

  // ─── Client-side filtering + sorting ────────────────────────────────

  const processedViews = useMemo(() => {
    let result = [...allViews]

    // Multi-workspace client-side filter (API only supports single workspaceId)
    if (filters.workspaceIds.length > 1) {
      const wsSet = new Set(filters.workspaceIds)
      result = result.filter(v => wsSet.has(v.workspaceId))
    }

    // Category filters (client-side — API doesn't support these)
    if (filters.category === 'my-views' && filters.currentUserName) {
      const userName = filters.currentUserName.toLowerCase()
      result = result.filter(v => v.createdBy?.toLowerCase() === userName)
    } else if (filters.category === 'recently-added') {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      result = result.filter(v => new Date(v.createdAt).getTime() > sevenDaysAgo)
    } else if (filters.category === 'shared-with-me') {
      result = result.filter(v => v.visibility === 'workspace' || v.visibility === 'enterprise')
    }
    // 'my-favourites' is handled via favouritedOnly API param
    // 'needs-attention' is handled downstream via useViewHealth

    // Sort
    result = sortViews(result, filters.sort)

    return result
  }, [allViews, filters.workspaceIds, filters.category, filters.sort])

  // Paginated slice for display
  const views = useMemo(() => processedViews.slice(0, displayCount), [processedViews, displayCount])
  const hasMore = displayCount < processedViews.length

  // ─── Optimistic favourite toggle ────────────────────────────────────

  const toggleFavourite = useCallback((viewId: string) => {
    const view = allViews.find(v => v.id === viewId)
    if (!view) return

    const wasFavourited = view.isFavourited

    // Optimistic update
    setAllViews(prev => prev.map(v =>
      v.id === viewId
        ? { ...v, isFavourited: !wasFavourited, favouriteCount: v.favouriteCount + (wasFavourited ? -1 : 1) }
        : v
    ))
    setPopularViews(prev => prev.map(v =>
      v.id === viewId
        ? { ...v, isFavourited: !wasFavourited, favouriteCount: v.favouriteCount + (wasFavourited ? -1 : 1) }
        : v
    ))

    // API call — revert on error
    const apiCall = wasFavourited ? unfavouriteView(viewId) : favouriteView(viewId)
    apiCall.catch(() => {
      setAllViews(prev => prev.map(v =>
        v.id === viewId
          ? { ...v, isFavourited: wasFavourited, favouriteCount: v.favouriteCount + (wasFavourited ? 1 : -1) }
          : v
      ))
      setPopularViews(prev => prev.map(v =>
        v.id === viewId
          ? { ...v, isFavourited: wasFavourited, favouriteCount: v.favouriteCount + (wasFavourited ? 1 : -1) }
          : v
      ))
    })
  }, [allViews])

  // ─── Remove view (optimistic, after delete) ────────────────────────

  const removeView = useCallback((viewId: string) => {
    setAllViews(prev => prev.filter(v => v.id !== viewId))
    setPopularViews(prev => prev.filter(v => v.id !== viewId))
  }, [])

  // ─── Refetch (trigger full reload from API) ────────────────────────

  const refetch = useCallback(() => {
    setRefetchKey(k => k + 1)
  }, [])

  // ─── Load more (infinite scroll) ───────────────────────────────────

  const loadMore = useCallback(() => {
    setDisplayCount(prev => prev + filters.limit)
  }, [filters.limit])

  return {
    views,
    totalCount: processedViews.length,
    popularViews,
    isLoading,
    error,
    toggleFavourite,
    removeView,
    refetch,
    loadMore,
    hasMore,
  }
}
