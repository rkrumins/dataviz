/**
 * useBookmarkedViews — fetches the current user's bookmarked views via the
 * isFavourited / favourite API.  Provides an optimistic toggleBookmark action.
 *
 * Semantics: "Bookmark" = personal quick-access (sidebar navigation intent).
 * The backing data is the same `favourite` concept used in Explorer/Gallery,
 * just presented with different framing here.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  listViews,
  favouriteView,
  unfavouriteView,
  type View,
} from '@/services/viewApiService'

export function useBookmarkedViews() {
  const [bookmarks, setBookmarks] = useState<View[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchBookmarks = useCallback(async () => {
    try {
      const views = await listViews({ favouritedOnly: true })
      setBookmarks(views)
    } catch (err) {
      console.error('[useBookmarkedViews] Failed to fetch bookmarks:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBookmarks()
  }, [fetchBookmarks])

  /**
   * Toggle the bookmark state for a view.
   * - isCurrentlyBookmarked=true  → remove bookmark (optimistic remove)
   * - isCurrentlyBookmarked=false → add bookmark (re-fetch to get full data)
   */
  const toggleBookmark = useCallback(async (viewId: string, isCurrentlyBookmarked: boolean) => {
    if (isCurrentlyBookmarked) {
      // Optimistic remove — feels instant
      setBookmarks(prev => prev.filter(v => v.id !== viewId))
    }
    try {
      if (isCurrentlyBookmarked) {
        await unfavouriteView(viewId)
      } else {
        await favouriteView(viewId)
        await fetchBookmarks()  // re-fetch so the new bookmark shows with full metadata
      }
    } catch (err) {
      console.error('[useBookmarkedViews] Failed to toggle bookmark:', err)
      fetchBookmarks()  // revert optimistic update on error
    }
  }, [fetchBookmarks])

  return {
    bookmarks,
    isLoading,
    toggleBookmark,
    refetch: fetchBookmarks,
  }
}
