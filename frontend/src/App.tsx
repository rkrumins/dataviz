import React, { useEffect, useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { router } from './routes'
import { GraphProvider } from '@/providers/GraphProviderContext'
import { BackendHealthBanner } from '@/components/layout/BackendHealthBanner'
import { useAuthStore, usePermission, useAnyWorkspacePermission } from '@/store/auth'
import {
  enableProviderStatusPolling,
  disableProviderStatusPolling,
} from '@/store/providerStatus'
import {
  enableProviderHealthPolling,
  disableProviderHealthPolling,
} from '@/store/providerHealth'
import {
  enablePermissionPolling,
  disablePermissionPolling,
} from '@/store/permissionPoller'
import {
  enableSessionKeepalive,
  disableSessionKeepalive,
} from '@/store/sessionKeepalive'
import { usePreferencesStore } from '@/store/preferences'
import { startChangeFeed } from '@/store/changeFeed'
import { queryClient } from '@/lib/queryClient'

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
      // Logout / session-lost: drop the change-feed subscriptions so
      // nothing keeps refreshing against an empty cookie.
      disablePermissionPolling()
      disableProviderHealthPolling()
      disableSessionKeepalive()
      return
    }
    // Renew the access token before it expires rather than after a 401.
    // Started here, alongside the subscriptions, because both need the
    // same precondition — a resolved, authenticated session.
    enableSessionKeepalive()
    // The change feed. One manifest read tells every subscribed surface
    // below whether it has anything to fetch, which is what lets them
    // stop asking on their own timers. Started before them so the first
    // manifest is usually in hand by the time they subscribe — a
    // subscriber that already knows the current version seeds from it
    // silently instead of refetching what it just fetched on mount.
    const stopChangeFeed = startChangeFeed()
    // Public endpoint — every authenticated user.
    enableProviderHealthPolling()
    // Workspace-scoped read endpoint. Toggle in both directions so a
    // mid-session demotion that drops provider:read unsubscribes.
    if (canPollProviders) enableProviderStatusPolling()
    else disableProviderStatusPolling()
    // Catch idle-user permission updates and cross-tab changes. The
    // subscriber compares against its own last snapshot, so a stable
    // claims response is a silent no-op.
    enablePermissionPolling()
    return stopChangeFeed
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

/**
 * The whole app tree.
 *
 * This lives here, not in ``main.tsx``, because a module that declares React
 * components gets a react-refresh accept boundary injected by the Vite plugin.
 * When that module is the entry, HMR re-imports and re-executes it — and the
 * entry's ``createRoot()`` then runs a second time on ``#root`` ("You are
 * calling ReactDOMClient.createRoot() on a container that has already been
 * passed to createRoot() before"), leaving two live React trees. Keeping every
 * component out of the entry makes this file the boundary instead, so edits
 * hot-refresh here and the entry is only ever re-run by a full page reload.
 *
 * GraphProvider manages the RemoteGraphProvider lifecycle internally, creating
 * a workspace-scoped instance whenever the active workspace changes.
 * RouterProvider handles URL-based navigation; AppLayout (inside routes)
 * manages auth, schema init, and the shell (TopBar + SidebarNav + Outlet).
 */
/**
 * True on the standalone /docs and /guide routes. The health banner is mounted
 * outside <RouterProvider>, so react-router hooks aren't available here — we
 * read the path reactively from the data router's own subscription instead, so
 * it updates across in-app SPA navigation, not just full page loads.
 */
function useIsDocsOrGuide() {
  const [path, setPath] = useState(() => router.state.location.pathname)
  useEffect(() => router.subscribe((s) => setPath(s.location.pathname)), [])
  return path.startsWith('/docs') || path.startsWith('/guide')
}

export function App() {
  const hideProviderBanner = useIsDocsOrGuide()
  return (
    <QueryClientProvider client={queryClient}>
      <MotionRoot>
        <AuthBootstrap>
          <div className="h-screen w-screen flex flex-col overflow-hidden">
            <BackendHealthBanner hideProviderBanner={hideProviderBanner} />
            <div className="flex-1 overflow-hidden">
              <GraphProvider>
                <RouterProvider router={router} />
              </GraphProvider>
            </div>
          </div>
        </AuthBootstrap>
      </MotionRoot>
    </QueryClientProvider>
  )
}
