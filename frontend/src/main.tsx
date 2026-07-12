import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { router } from './routes'
import './styles/globals.css'
import { GraphProvider } from '@/providers/GraphProviderContext'
import { BackendHealthBanner } from '@/components/layout/BackendHealthBanner'
import { useAuthStore, usePermission, useAnyWorkspacePermission } from '@/store/auth'
import {
  enableProviderStatusPolling,
  disableProviderStatusPolling,
} from '@/store/providerStatus'
import { enableProviderHealthPolling } from '@/store/providerHealth'
import {
  enablePermissionPolling,
  disablePermissionPolling,
} from '@/store/permissionPoller'
import { useBrandingStore } from '@/store/branding'
import { useFeaturesStore } from '@/store/features'
import { usePreferencesStore } from '@/store/preferences'
import { installRadixPointerEventsGuard } from '@/lib/radixPointerEventsGuard'

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
  // Phase 17/18: provider-status polling hits ``/admin/providers/status``
  // which is now ``workspace:provider:read``-gated (Phase 18) — readers
  // get their workspaces' providers' status, admins get all. Subscribe
  // to the claims so the poller starts once they hydrate AND tears down
  // on demotion. Bootstrap flips ``status → 'authenticated'`` BEFORE
  // awaiting hydratePermissions, so an inline ``can()`` check at
  // status-flip time would be empty — the effect re-runs when claims
  // land. Both hooks are called unconditionally (Rules of Hooks).
  const isPlatformAdmin = usePermission('system:admin')
  const canReadProviders = useAnyWorkspacePermission('workspace:provider:read')
  const canPollProviders = isPlatformAdmin || canReadProviders

  useEffect(() => {
    void bootstrap()
    const onSessionLost = () => useAuthStore.getState().handleSessionLost()
    window.addEventListener('auth:session-lost', onSessionLost)
    return () => window.removeEventListener('auth:session-lost', onSessionLost)
  }, [bootstrap])

  useEffect(() => {
    if (status !== 'authenticated') {
      // Logout / session-lost: stop the permission poller so it
      // doesn't keep firing /me/permissions against an empty cookie.
      disablePermissionPolling()
      return
    }
    // Public endpoint — every authenticated user.
    enableProviderHealthPolling()
    // Workspace-scoped read endpoint. Toggle in both directions so a
    // mid-session demotion that drops provider:read stops the timer.
    if (canPollProviders) enableProviderStatusPolling()
    else disableProviderStatusPolling()
    // Catch idle-user permission updates and cross-tab changes. The
    // poller compares against its own last snapshot, so a stable
    // claims response is a silent no-op.
    enablePermissionPolling()
  }, [status, canPollProviders])

  // Block rendering until auth resolves — prevents premature API calls
  if (status === 'idle' || status === 'loading') return null

  return <>{children}</>
}

/**
 * Applies the app-wide motion policy. ``reducedMotion="user"`` makes every
 * framer-motion animation honour the OS "Reduce motion" setting — an
 * accessibility win that leaves the default, fully-animated experience
 * unchanged for everyone else. The persisted app preference can force
 * ``"always"`` (in-app calm mode). Must wrap the whole tree so it also
 * governs the always-mounted banners.
 */
function MotionRoot({ children }: { children: React.ReactNode }) {
  const reduce = usePreferencesStore((s) => s.reducedMotion)
  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'user'}>{children}</MotionConfig>
  )
}

// Branding is public and independent of auth — kick the fetch off at module
// load so the tab title, favicon and accent colour resolve as early as
// possible (the store is seeded with stock defaults, so first paint is
// always correct even before this resolves). Fire-and-forget: a failure
// keeps the seed in place.
void useBrandingStore.getState().loadBranding()

// Feature flags ride the same boot pattern (public, fail-open to seeds) so
// admin-disabled areas (e.g. versioning) are hidden before first interaction.
void useFeaturesStore.getState().loadFeatures()

// App-wide safety net for the Radix body pointer-events freeze: a modal layer
// (Dialog / modal DropdownMenu) that unmounts while open can otherwise leave
// the entire app unclickable until a hard reload. Idempotent; lives for the
// whole app lifetime, independent of auth/routing.
installRadixPointerEventsGuard()

// GraphProvider manages the RemoteGraphProvider lifecycle internally,
// creating a workspace-scoped instance whenever the active workspace changes.
// RouterProvider handles URL-based navigation; AppLayout (inside routes)
// manages auth, schema init, and the shell (TopBar + SidebarNav + Outlet).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionRoot>
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
      </MotionRoot>
    </QueryClientProvider>
  </React.StrictMode>,
)
