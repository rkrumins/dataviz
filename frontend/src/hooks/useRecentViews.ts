/**
 * useRecentViews — tracks the last N views the user has visited, persisted
 * in localStorage via a Zustand store.
 *
 * Uses Zustand so that ALL consumers (sidebar, popovers, command palette)
 * react in real-time when a view is visited — no page refresh needed.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface RecentViewEntry {
  viewId: string
  viewName: string
  /** View layout type — used to select the appropriate icon. */
  viewType: string
  workspaceId?: string
  workspaceName?: string
  /** Datasource the view belongs to — used to switch context on click. */
  dataSourceId?: string
  dataSourceName?: string
  visitedAt: string  // ISO 8601 timestamp
}

const MAX_RECENT = 5

interface RecentViewsState {
  recent: RecentViewEntry[]
  recordVisit: (entry: Omit<RecentViewEntry, 'visitedAt'>) => void
}

const useRecentViewsStore = create<RecentViewsState>()(
  persist(
    (set, get) => ({
      recent: [],
      recordVisit: (entry) => {
        const existing = get().recent.filter(e => e.viewId !== entry.viewId)
        const updated: RecentViewEntry[] = [
          { ...entry, visitedAt: new Date().toISOString() },
          ...existing,
        ].slice(0, MAX_RECENT)
        set({ recent: updated })
      },
    }),
    {
      name: 'synodic-recent-views',
    }
  )
)

/** Hook wrapper — returns the same shape as the old useState-based hook. */
export function useRecentViews() {
  const recent = useRecentViewsStore((s) => s.recent)
  const recordVisit = useRecentViewsStore((s) => s.recordVisit)
  return { recent, recordVisit }
}
