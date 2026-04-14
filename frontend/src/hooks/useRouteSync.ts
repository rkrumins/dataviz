/**
 * Bidirectional sync between React Router location and Zustand navigation store.
 * This allows legacy components still reading `activeTab` to stay in sync
 * while new code uses React Router directly.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useNavigationStore, type NavigationTab } from '@/store/navigation'

export function useRouteSync() {
  const location = useLocation()
  const activeTab = useNavigationStore((s) => s.activeTab)
  const setActiveTab = useNavigationStore((s) => s.setActiveTab)

  useEffect(() => {
    const path = location.pathname
    let nextTab: NavigationTab | null = null

    if (path.startsWith('/dashboard')) {
      nextTab = 'dashboard'
    } else if (path.startsWith('/views') || path.startsWith('/explorer')) {
      nextTab = 'explore'
    } else if (path.startsWith('/ingestion')) {
      nextTab = 'ingestion'
    } else if (path.startsWith('/workspaces')) {
      // Covers /workspaces (listing) and /workspaces/:id (detail)
      nextTab = 'workspaces'
    } else if (path.startsWith('/schema')) {
      nextTab = 'schema'
    } else if (path.startsWith('/admin')) {
      nextTab = 'admin'
    }

    // Guard against no-op store writes (important for preventing update loops
    // in strict mode and during router/store sync).
    if (nextTab && nextTab !== activeTab) {
      setActiveTab(nextTab)
    }
  }, [location.pathname, activeTab, setActiveTab])
}
