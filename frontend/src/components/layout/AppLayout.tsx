/**
 * Root layout component for the app. Wraps all routes with:
 * - Auth guard
 * - ReactFlowProvider
 * - Schema/graph initialization
 * - TopBar, SidebarNav, and React Router Outlet
 *
 * Refactored from AppShell + App.tsx to support route-based navigation.
 */
import { useEffect, useState, createContext, useContext } from 'react'
import { Outlet, Navigate } from 'react-router-dom'
import { TopBar } from './TopBar'
import { GlobalAnnouncementBanner } from './GlobalAnnouncementBanner'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { ViewWizard } from '@/components/views/ViewWizard'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { listViews, viewToViewConfig } from '@/services/viewApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useRouteSync } from '@/hooks/useRouteSync'
import { cn } from '@/lib/utils'

// Context for View Editor Modal
interface ViewEditorContextType {
  openViewEditor: (viewId?: string) => void
  closeViewEditor: () => void
}

const ViewEditorContext = createContext<ViewEditorContextType | null>(null)

export function useViewEditorModal() {
  const context = useContext(ViewEditorContext)
  if (!context) {
    throw new Error('useViewEditorModal must be used within AppLayout')
  }
  return context
}

export function AppLayout() {
  const { isAuthenticated } = useAuthStore()
  const { theme, sidebarCollapsed } = usePreferencesStore()

  // View editor state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [viewEditorOpen, setViewEditorOpen] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | undefined>()

  const openViewEditor = (viewId?: string) => {
    setEditingViewId(viewId)
    setViewEditorOpen(true)
  }
  const closeViewEditor = () => {
    setViewEditorOpen(false)
    setEditingViewId(undefined)
  }

  // Sync React Router location with Zustand navigation store
  useRouteSync()

  // Load views from the API into the schema store cache.
  // Fetches ALL accessible views (no workspace filter) so that cross-workspace
  // links in the sidebar and deep-linked URLs resolve without a page refresh.
  // Re-runs when activeWorkspaceId changes so newly created views are picked up.
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  useEffect(() => {
    if (!isAuthenticated) return

    const loadViews = async () => {
      try {
        const views = await listViews()
        // Single set() call — avoids N sequential Zustand updates that can
        // overwhelm useSyncExternalStore subscribers during mount.
        useSchemaStore.getState().upsertViews(views.map(viewToViewConfig))
      } catch (err) {
        console.error('[AppLayout] Failed to load views from API:', err)
      }
    }
    loadViews()
  }, [isAuthenticated, activeWorkspaceId])

  // Apply theme
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.toggle('dark', systemDark)
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => root.classList.toggle('dark', e.matches)
      mediaQuery.addEventListener('change', handler)
      return () => mediaQuery.removeEventListener('change', handler)
    } else {
      root.classList.toggle('dark', theme === 'dark')
    }
  }, [theme])

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor }}>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-canvas">
        <GlobalAnnouncementBanner />
        <TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />

        <div className="flex-1 flex overflow-hidden">
          <SidebarNav />

          <main
            className={cn(
              "flex-1 relative overflow-hidden transition-all duration-300",
              sidebarCollapsed ? "ml-16" : "ml-64"
            )}
          >
            <Outlet />
          </main>
        </div>

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
        />

        <ViewWizard
          mode={editingViewId ? 'edit' : 'create'}
          viewId={editingViewId}
          isOpen={viewEditorOpen}
          onClose={closeViewEditor}
          onComplete={() => closeViewEditor()}
        />
      </div>
    </ViewEditorContext.Provider>
  )
}
