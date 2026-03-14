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
  const { setActiveTab } = useNavigationStore()

  useEffect(() => {
    const path = location.pathname

    if (path.startsWith('/dashboard')) {
      setActiveTab('dashboard')
    } else if (path.startsWith('/views')) {
      setActiveTab('explore')
    } else if (path.startsWith('/workspaces')) {
      setActiveTab('explore')
    } else if (path.startsWith('/schema')) {
      setActiveTab('schema')
    }
  }, [location.pathname, setActiveTab])
}
