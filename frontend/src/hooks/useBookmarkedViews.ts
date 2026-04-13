/**
 * useBookmarkedViews — exposes the current user's bookmarked views.
 *
 * Backed by React Query so every component that subscribes shares a
 * single cache entry. This prevents the N-component-N-request pattern
 * the hook used to exhibit when three layout components each mounted
 * their own ``useState`` + ``useEffect`` fetch.
 *
 * Semantics: "Bookmark" = personal quick-access (sidebar navigation
 * intent). The backing data is the same ``favourite`` concept used in
 * Explorer/Gallery, just surfaced differently here.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listViews,
  favouriteView,
  unfavouriteView,
  type View,
} from '@/services/viewApiService'

const BOOKMARKS_QUERY_KEY = ['views', 'bookmarks'] as const

export function useBookmarkedViews() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: BOOKMARKS_QUERY_KEY,
    queryFn: async (): Promise<View[]> => {
      const { items } = await listViews({ favouritedOnly: true })
      return items
    },
    // Bookmarks don't go stale quickly — default TTL is fine. The 30s
    // stale time de-dupes the burst of mounts at app startup.
    staleTime: 30_000,
  })

  const bookmarks = query.data ?? []

  /**
   * Toggle the bookmark state for a view.
   * - isCurrentlyBookmarked=true  → remove bookmark (optimistic remove)
   * - isCurrentlyBookmarked=false → add bookmark (invalidate to refetch
   *   so the newly-bookmarked view appears with full metadata)
   */
  const toggleBookmark = useCallback(async (viewId: string, isCurrentlyBookmarked: boolean) => {
    // Optimistic remove applied immediately via cache surgery.
    if (isCurrentlyBookmarked) {
      queryClient.setQueryData<View[]>(
        BOOKMARKS_QUERY_KEY,
        (prev) => (prev ?? []).filter(v => v.id !== viewId),
      )
    }
    try {
      if (isCurrentlyBookmarked) {
        await unfavouriteView(viewId)
      } else {
        await favouriteView(viewId)
      }
      // Refresh the canonical list from the server so added bookmarks
      // gain full metadata and optimistic removes are confirmed.
      queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
    } catch (err) {
      console.error('[useBookmarkedViews] Failed to toggle bookmark:', err)
      // Revert optimistic state via refetch.
      queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY })
    }
  }, [queryClient])

  return {
    bookmarks,
    isLoading: query.isLoading,
    toggleBookmark,
    refetch: () => queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY }),
  }
}
