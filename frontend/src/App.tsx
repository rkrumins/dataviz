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
import { featureEnabled } from '@/store/features'
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
    //
    // The flag gates only the STREAM, not the feed: with it off the
    // periodic manifest check still runs, so every surface still updates
    // — within the admin's check interval (a minute by default) rather
    // than within a second. That is why turning this off is a latency
    // decision and never a correctness one.
    const stopChangeFeed = startChangeFeed({
      stream: featureEnabled('realtimeChangeFeedEnabled'),
    })
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

/**
 * Pages outside AppLayout (sign-in, sign-up, the password pages) scroll in the
 * shell's route box, and that box outlives navigation: without this, "Sign up"
 * clicked at the foot of a scrolled sign-in card opens the next page part-way
 * down. A new page is a new child of the box, so reset when one mounts. That
 * lands after React commits the page and before the browser paints it, which
 * a router subscription cannot: the location changes first, and a lazy page
 * may still be downloading.
 */
function resetScrollOnPageSwap(box: HTMLDivElement | null) {
  if (!box) return
  const observer = new MutationObserver(() => { box.scrollTop = 0 })
  observer.observe(box, { childList: true })
  return () => observer.disconnect()
}

export function App() {
  const hideProviderBanner = useIsDocsOrGuide()
  return (
    <QueryClientProvider client={queryClient}>
      <MotionRoot>
        <AuthBootstrap>
          {/* dvh where supported: on a phone 100vh is the height with the
              browser toolbar hidden, which puts the bottom of every page
              under the toolbar. A variant because plain `h-dvh` is emitted
              before `h-screen` and would lose to it. */}
          <div className="h-screen supports-[height:100dvh]:h-dvh w-screen flex flex-col overflow-hidden">
            <BackendHealthBanner hideProviderBanner={hideProviderBanner} />
            {/* Scrolls every page outside AppLayout: they fill it with
                `min-h-full` and grow past it. AppLayout fits it exactly and
                scrolls its own pages. This puts the sign-in cards' backdrop
                blur inside a scroller, which noBackdropFilterInScrollers
                cannot see across files: accepted, because it only scrolls
                when a card does not fit the window. */}
            <div ref={resetScrollOnPageSwap} className="flex-1 overflow-x-hidden overflow-y-auto custom-scrollbar">
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
