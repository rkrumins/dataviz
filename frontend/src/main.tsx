import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './routes'
import './styles/globals.css'
import { GraphProvider } from '@/providers/GraphProviderContext'
import { BackendHealthBanner } from '@/components/layout/BackendHealthBanner'
import { useAuthStore, usePermission } from '@/store/auth'
import {
  enableProviderStatusPolling,
  disableProviderStatusPolling,
} from '@/store/providerStatus'
import { enableProviderHealthPolling } from '@/store/providerHealth'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5 minutes default stale time
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// Exposed for non-component modules (e.g. workspaceSwitchCleanup) that need
// to evict queries when the active workspace changes. Returns null during
// module load before this file has executed — callers must tolerate that.
export function getQueryClient(): QueryClient | null {
  return queryClient
}

/**
 * Validate the access cookie against the server exactly once on app boot
 * and again whenever the auth store is reset to ``idle`` (e.g. by tests).
 * The store is the only source of truth for ``isAuthenticated``; route
 * guards read from it.
 *
 * Children are NOT rendered until bootstrap resolves (status leaves
 * ``idle``/``loading``). This prevents GraphProvider, polling stores,
 * and workspace loaders from firing requests before we know whether the
 * user is authenticated — eliminating the startup request storm on the
 * login page.
 */
function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const status = useAuthStore((s) => s.status)
  // Phase 17: provider-status polling hits ``/admin/providers/status``
  // (system:admin-gated). Subscribe to the claim so the poller starts
  // for an admin once claims hydrate AND tears down on demotion.
  // Bootstrap flips ``status → 'authenticated'`` BEFORE awaiting
  // hydratePermissions, so an inline ``can()`` check at status-flip
  // time would be empty — the effect re-runs when claims land.
  const canPollProviders = usePermission('system:admin')

  useEffect(() => {
    void bootstrap()
    const onSessionLost = () => useAuthStore.getState().handleSessionLost()
    window.addEventListener('auth:session-lost', onSessionLost)
    return () => window.removeEventListener('auth:session-lost', onSessionLost)
  }, [bootstrap])

  useEffect(() => {
    if (status !== 'authenticated') return
    // Public endpoint — every authenticated user.
    enableProviderHealthPolling()
    // Admin-only endpoint — only super_admin. Toggle in both
    // directions so a mid-session demotion stops the timer.
    if (canPollProviders) enableProviderStatusPolling()
    else disableProviderStatusPolling()
  }, [status, canPollProviders])

  // Block rendering until auth resolves — prevents premature API calls
  if (status === 'idle' || status === 'loading') return null

  return <>{children}</>
}

// GraphProvider manages the RemoteGraphProvider lifecycle internally,
// creating a workspace-scoped instance whenever the active workspace changes.
// RouterProvider handles URL-based navigation; AppLayout (inside routes)
// manages auth, schema init, and the shell (TopBar + SidebarNav + Outlet).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthBootstrap>
        <div className="h-screen w-screen flex flex-col overflow-hidden">
          <BackendHealthBanner />
          <div className="flex-1 overflow-hidden">
            <GraphProvider>
              <RouterProvider router={router} />
            </GraphProvider>
          </div>
        </div>
      </AuthBootstrap>
    </QueryClientProvider>
  </React.StrictMode>,
)
