/**
 * Bidirectional sync between React Router location and Zustand navigation store.
 * This allows legacy components still reading `activeTab` to stay in sync
 * while new code uses React Router directly.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useNavigationStore } from '@/store/navigation'

export function useRouteSync() {
  const location = useLocation()
  const activeTab = useNavigationStore((s) => s.activeTab)
  const setActiveTab = useNavigationStore((s) => s.setActiveTab)

  useEffect(() => {
    const path = location.pathname
    let nextTab: 'dashboard' | 'explore' | 'schema' | null = null

    if (path.startsWith('/dashboard')) {
      nextTab = 'dashboard'
    } else if (path.startsWith('/views')) {
      nextTab = 'explore'
    } else if (path.startsWith('/workspaces')) {
      nextTab = 'explore'
    } else if (path.startsWith('/schema')) {
      nextTab = 'schema'
    }

    // Guard against no-op store writes (important for preventing update loops
    // in strict mode and during router/store sync).
    if (nextTab && nextTab !== activeTab) {
      setActiveTab(nextTab)
    }
  }, [location.pathname, activeTab, setActiveTab])
}
