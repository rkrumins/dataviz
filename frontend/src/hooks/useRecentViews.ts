/**
 * useRecentViews — tracks the last N views the user has visited, persisted
 * in localStorage.  Call `recordVisit()` from ViewPage when a view loads.
 * The sidebar reads `recent` to display the auto-populated "Recent" list.
 */
import { useState, useCallback } from 'react'

export interface RecentViewEntry {
  viewId: string
  viewName: string
  /** View layout type — used to select the appropriate icon. */
  viewType: string
  workspaceId?: string
  workspaceName?: string
  /** Datasource the view belongs to — used to switch context on click. */
  dataSourceId?: string
  visitedAt: string  // ISO 8601 timestamp
}

const STORAGE_KEY = 'synodic-recent-views'
const MAX_RECENT = 5

function readStorage(): RecentViewEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RecentViewEntry[]) : []
  } catch {
    return []
  }
}

export function useRecentViews() {
  const [recent, setRecent] = useState<RecentViewEntry[]>(readStorage)

  const recordVisit = useCallback((entry: Omit<RecentViewEntry, 'visitedAt'>) => {
    const existing = readStorage().filter(e => e.viewId !== entry.viewId)
    const updated: RecentViewEntry[] = [
      { ...entry, visitedAt: new Date().toISOString() },
      ...existing,
    ].slice(0, MAX_RECENT)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    setRecent(updated)
  }, [])

  return { recent, recordVisit }
}
