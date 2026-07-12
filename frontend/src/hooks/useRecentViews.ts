/**
 * useRecentViews — the user's recently-visited views ("Continue where you left off").
 *
 * SERVER-BACKED (was a localStorage-persisted Zustand store). The browser-local
 * version had three enterprise problems:
 *   1. It didn't follow the user — switch machine or browser and your recents
 *      were gone.
 *   2. The storage key was NOT user-scoped, so a second user signing in on the
 *      same browser inherited the previous user's recent views.
 *   3. It cached a stale snapshot of each view's name/scope, so a renamed view
 *      showed its old name and a deleted one stayed in the strip and 404'd.
 *
 * The server keeps one upserted row per (user, view) and joins the read against
 * the LIVE views, which fixes all three: per-identity, cross-device, always
 * fresh, and deleted views drop out on their own (FK cascade).
 *
 * The public API ({ recent, recordVisit }) is unchanged, so the sidebar, command
 * palette, dashboard and Explorer strip all keep working as-is.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getRecentViews,
  recordViewVisit,
  type RecentViewEntry,
} from '@/services/viewApiService'

export type { RecentViewEntry }

export const RECENT_VIEWS_QUERY_KEY = 'recent-views' as const

const EMPTY: RecentViewEntry[] = []

export function useRecentViews() {
  const queryClient = useQueryClient()

  const { data } = useQuery<RecentViewEntry[], Error>({
    queryKey: [RECENT_VIEWS_QUERY_KEY],
    queryFn: () => getRecentViews(5),
    staleTime: 30_000,
    retry: 1,
  })

  /**
   * Record a visit. The caller still passes the full entry (unchanged
   * signature) but only the id is sent — the server derives the rest from the
   * live view, which is precisely why the names can't go stale.
   *
   * Fire-and-forget: recents are a convenience, so a failure here must never
   * break navigation to the view the user actually asked for.
   */
  const recordVisit = useCallback(
    (entry: Omit<RecentViewEntry, 'visitedAt'>) => {
      recordViewVisit(entry.viewId)
        .then(() => queryClient.invalidateQueries({ queryKey: [RECENT_VIEWS_QUERY_KEY] }))
        .catch(() => { /* non-fatal */ })
    },
    [queryClient],
  )

  return { recent: data ?? EMPTY, recordVisit }
}
