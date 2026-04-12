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
import { AlertTriangle, Home, LogIn, Lock } from 'lucide-react'
import { TopBar } from './TopBar'
import { GlobalAnnouncementBanner } from './GlobalAnnouncementBanner'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { ViewWizard } from '@/components/views/ViewWizard'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { listViews, viewToViewConfig } from '@/services/viewApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useRouteSync } from '@/hooks/useRouteSync'
import { useBackendRecovery } from '@/hooks/useBackendRecovery'
import { ViewEditorContext, useViewEditorModal } from './viewEditorContext'

export { useViewEditorModal }

export function AppLayout() {
  const { isAuthenticated, sessionExpired, login, logout } = useAuthStore()
  const { theme } = usePreferencesStore()
  const [reAuthPassword, setReAuthPassword] = useState('')
  const [reAuthError, setReAuthError] = useState('')
  const [reAuthLoading, setReAuthLoading] = useState(false)
  const userEmail = useAuthStore((s) => s.user?.email)

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

  // Sync React Router location with Zustand navigation store
  useRouteSync()

  // Auto-recover data when backend comes back from an outage
  useBackendRecovery()

  // Load views from the API into the schema store cache.
  // Fetches ALL accessible views (no workspace filter) so that cross-workspace
  // links in the sidebar and deep-linked URLs resolve without a page refresh.
  // Re-runs when activeWorkspaceId or activeDataSourceId changes so newly
  // created views and data-source-scoped views are picked up.
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
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
  }, [isAuthenticated, activeWorkspaceId, activeDataSourceId])

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

  const handleReAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userEmail || !reAuthPassword) return
    setReAuthLoading(true)
    setReAuthError('')
    const ok = await login(userEmail, reAuthPassword)
    setReAuthLoading(false)
    if (ok) {
      setReAuthPassword('')
      setReAuthError('')
    } else {
      setReAuthError('Invalid password. Try again or sign out.')
    }
  }

  const handleSignOut = () => {
    setReAuthPassword('')
    setReAuthError('')
    logout()
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
            className="flex-1 relative overflow-hidden transition-all duration-300"
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

        {/* Session expired overlay — re-auth without losing page state */}
        {sessionExpired && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
            <div className="bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
              <div className="flex flex-col items-center mb-5">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-3">
                  <Lock className="w-6 h-6 text-amber-500" />
                </div>
                <h2 className="text-lg font-bold text-ink">Session Expired</h2>
                <p className="text-sm text-ink-muted mt-1 text-center">
                  Enter your password to continue as <span className="font-medium text-ink">{userEmail}</span>
                </p>
              </div>

              <form onSubmit={handleReAuth} className="space-y-3">
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="password"
                    placeholder="Password"
                    value={reAuthPassword}
                    onChange={(e) => setReAuthPassword(e.target.value)}
                    className="input pl-10 h-11 w-full text-sm"
                    autoFocus
                  />
                </div>

                {reAuthError && (
                  <p className="text-xs text-red-500 px-1">{reAuthError}</p>
                )}

                <button
                  type="submit"
                  disabled={!reAuthPassword || reAuthLoading}
                  className="w-full h-10 rounded-xl bg-accent-lineage text-white text-sm font-semibold flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reAuthLoading ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <LogIn className="w-4 h-4" />
                      Continue
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleSignOut}
                  className="w-full h-9 rounded-xl text-sm text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Sign out instead
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </ViewEditorContext.Provider>
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
