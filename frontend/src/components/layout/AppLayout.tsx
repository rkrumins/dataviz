/**
 * Root layout component for the app. Wraps all routes with:
 * - Auth guard
 * - ReactFlowProvider
 * - Schema/graph initialization
 * - TopBar, SidebarNav, and React Router Outlet
 *
 * Refactored from AppShell + App.tsx to support route-based navigation.
 */
import { useEffect, useState } from 'react'
import { Outlet, Navigate, useNavigate } from 'react-router-dom'
import { AlertTriangle, Home } from 'lucide-react'
import { TopBar } from './TopBar'
import { GlobalAnnouncementBanner } from './GlobalAnnouncementBanner'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { HelpPanel } from '@/components/help/HelpPanel'
import { useHelpPanelStore } from '@/store/helpPanel'
import { ViewWizard } from '@/components/views/ViewWizard'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { listViews, viewToViewConfig } from '@/services/viewApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useBackendRecovery } from '@/hooks/useBackendRecovery'
import { useAppliedTheme } from '@/hooks/useAppliedTheme'
import { ViewEditorContext, useViewEditorModal } from './viewEditorContext'
import { ToastContainer } from '@/components/ui/toast'
import { AccessDeniedModal } from '@/components/auth/AccessDeniedModal'
import { useFeature } from '@/store/features'
import { TourOverlay } from '@/features/tour/TourOverlay'
import { TourLauncher } from '@/features/tour/TourLauncher'

export { useViewEditorModal }

export function AppLayout() {
  const status = useAuthStore((s) => s.status)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  // Selector subscriptions (not whole-store) so this always-mounted shell
  // only re-renders when these specific fields change, not on every
  // unrelated preference write (sidebar collapse, pinned views, …).
  const reducedMotion = usePreferencesStore((s) => s.reducedMotion)
  const toursEnabled = useFeature('toursEnabled')

  // View editor state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [viewEditorOpen, setViewEditorOpen] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | undefined>()
  const [initialScope, setInitialScope] = useState<{ workspaceId?: string; dataSourceId?: string }>({})

  const openViewEditor = (viewId?: string, options?: { workspaceId?: string; dataSourceId?: string }) => {
    setEditingViewId(viewId)
    setInitialScope(options ?? {})
    setViewEditorOpen(true)
  }
  const closeViewEditor = () => {
    setViewEditorOpen(false)
    setEditingViewId(undefined)
    setInitialScope({})
  }

  // Auto-recover data when backend comes back from an outage
  useBackendRecovery()

  // Load views from the API into the schema store cache.
  // Fetches ALL accessible views (no workspace filter) so that cross-workspace
  // links in the sidebar and deep-linked URLs resolve without a page refresh.
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  useEffect(() => {
    if (!isAuthenticated) return

    const loadViews = async () => {
      try {
        const { items } = await listViews()
        // Single set() call — avoids N sequential Zustand updates that can
        // overwhelm useSyncExternalStore subscribers during mount.
        useSchemaStore.getState().upsertViews(items.map(viewToViewConfig))
      } catch (err) {
        console.error('[AppLayout] Failed to load views from API:', err)
      }
    }
    loadViews()
  }, [isAuthenticated])

  // Applies the theme preference to <html class="dark">. See
  // useAppliedTheme for the anti-jank details — routes outside this layout
  // (e.g. /docs, /guide) call the same hook directly since this effect only
  // runs where AppLayout is mounted.
  useAppliedTheme()

  // Mirror the reduced-motion preference onto <html> so the CSS calm-mode
  // block (globals.css) can quiet always-on keyframes. Framer animations are
  // gated separately by <MotionConfig> in main.tsx.
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reducedMotion)
  }, [reducedMotion])

  // Global "?" shortcut toggles the Help drawer — ignored while typing in a
  // field so it never steals a literal question mark.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable
      ) {
        return
      }
      e.preventDefault()
      useHelpPanelStore.getState().toggleHelp()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // While the cookie is being validated against the server, render a
  // neutral loader. This prevents a flash of /login on cold reload when
  // the user is in fact authenticated.
  if (status === 'idle' || status === 'loading') {
    return <BootLoader />
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor }}>
      <div className="h-full w-full flex flex-col overflow-hidden bg-canvas">
        <GlobalAnnouncementBanner />
        <TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />

        <div className="flex-1 flex overflow-hidden">
          <SidebarNav />

          <main
            className="flex-1 relative overflow-hidden"
          >
            <ErrorBoundary
              resetKeys={[activeWorkspaceId]}
              fallback={(error, reset) => (
                <PageError error={error} onReset={reset} />
              )}
            >
              <Outlet />
            </ErrorBoundary>
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
          initialWorkspaceId={initialScope.workspaceId}
          initialDataSourceId={initialScope.dataSourceId}
        />

        <HelpPanel />
        <ToastContainer />
        <AccessDeniedModal />

        {/* Guided tours — experimental, gated by the toursEnabled feature flag */}
        {toursEnabled && <TourOverlay />}
        {toursEnabled && <TourLauncher />}
      </div>
    </ViewEditorContext.Provider>
  )
}

function BootLoader() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-canvas">
      <div className="w-8 h-8 border-2 border-ink-muted/30 border-t-accent-lineage rounded-full animate-spin" />
    </div>
  )
}

function PageError({ error, onReset }: { error: Error; onReset: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="w-full h-full flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-4 max-w-lg text-center">
        <div className="w-14 h-14 rounded-full bg-red-100 dark:bg-red-950/40 flex items-center justify-center">
          <AlertTriangle className="w-7 h-7 text-red-500" />
        </div>
        <h2 className="text-xl font-semibold text-ink">Something went wrong</h2>
        <p className="text-sm text-ink-muted">{error.message}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={onReset}
            className="px-4 py-2 rounded-lg bg-surface-elevated border border-border text-sm font-medium text-ink hover:bg-surface-hover transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => { onReset(); navigate('/dashboard') }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 transition-colors"
          >
            <Home className="w-4 h-4" />
            Dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
