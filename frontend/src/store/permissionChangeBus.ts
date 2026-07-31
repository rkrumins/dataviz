/**
 * Permission-change event bus.
 *
 * Why this exists:
 *   The auth claims (``useAuthStore.permissions``) and React Query
 *   caches are not the only permission-scoped state in the app.
 *   Several surfaces keep their own caches:
 *
 *     * ``useWorkspacesStore.workspaces`` (Zustand) — feeds the
 *       CommandPalette workspace list AND drives the active-workspace
 *       fallback when the user loses access to the one they're on.
 *     * Page-level ``useState`` in surfaces like ``WorkspacesPage``,
 *       ``AdminUsers``, ``IngestionPage`` etc. — they fetch on mount
 *       and don't auto-refresh.
 *
 *   ``queryClient.invalidateQueries()`` does nothing for these. So
 *   even with the silent refresh + auth-store update + React Query
 *   invalidation chain firing correctly, the sidebar / command
 *   palette / open page can still show a workspace the user has
 *   just lost access to.
 *
 *   This module is the single funnel called after a permission change
 *   is detected. It:
 *     1. Reloads the Zustand workspaces store so the CommandPalette
 *        + any consumer of ``s.workspaces`` repaints with the
 *        filtered-by-new-claims list. The store's own
 *        ``loadWorkspaces`` already handles the "active workspace no
 *        longer exists" fallback.
 *     2. Emits a ``permissions:changed`` ``window`` event so any
 *        page-level cache that wants to react can listen for it and
 *        re-fetch. Opt-in: pages that don't subscribe just stay on
 *        their last data until next navigation, which is acceptable.
 *
 *   Both callers (``fetchWithTimeout`` silent refresh and the 60s
 *   poller) go through this single function, so adding a new
 *   permission-scoped cache only requires hooking it in here once.
 */

/** Dispatched on ``window`` after the auth claims have changed. Any
 *  page-level cache that wants to refresh on permission change can
 *  ``window.addEventListener('permissions:changed', ...)``. */
export const PERMISSIONS_CHANGED_EVENT = 'permissions:changed'

/** Cross-tab sync. When Tab A's silent-refresh chain fires, every
 *  other tab on the same origin needs to react too — otherwise Tab B
 *  keeps its stale workspaces list for up to 60s (until its own
 *  poller fires) or until the user clicks something. BroadcastChannel
 *  has 100% support on every Synodic-targeted browser; we gate on
 *  feature-detect just to keep tests / SSR happy. */
const BROADCAST_CHANNEL_NAME = 'rbac-permissions'

const broadcastChannel: BroadcastChannel | null =
    typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
        : null

/** Local-only variant of the reload-everything hook. Used by both the
 *  public entry point AND the cross-tab message handler — the message
 *  handler MUST NOT re-broadcast (it would echo forever between two
 *  open tabs). The store reload + window dispatch are identical
 *  regardless of whether the trigger was local or cross-tab. */
async function notifyPermissionsChangedLocal(): Promise<void> {
    // 1. Workspaces Zustand store — used by CommandPalette and the
    //    active-workspace fallback. The action does its own
    //    "active workspace no longer exists" handling.
    try {
        const mod = await import('@/store/workspaces')
        await mod.useWorkspacesStore.getState().loadWorkspaces()
    } catch {
        // Best-effort: a failed reload just means the store stays
        // stale until the next navigation triggers it. The auth
        // store + React Query caches are already updated, so the
        // gating layer still blocks unauthorized data.
    }

    // 2. Emit the global event for any page that wants to refresh
    //    its component-level state (WorkspacesPage, IngestionPage,
    //    AdminUsers, etc.). Best-effort fire-and-forget.
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new CustomEvent(PERMISSIONS_CHANGED_EVENT))
        } catch {
            // ignore — older browsers / SSR shouldn't reach here.
        }
    }
}

if (broadcastChannel) {
    broadcastChannel.onmessage = (event: MessageEvent) => {
        // Filter on the kind tag so an unrelated channel message can't
        // trigger us. ``data`` may be undefined if some other code on
        // the same origin posts to the same channel name.
        if (event?.data?.kind === 'changed') {
            void notifyPermissionsChangedLocal()
        } else if (event?.data?.kind === 'signed-out') {
            void signOutLocal()
        }
    }
}

/** Tear this tab's session state down without calling the server.
 *
 *  The tab that signed out already did — the cookies are gone from the
 *  shared jar, so a /logout from here would be an unauthenticated POST,
 *  and the store transition is the entire point. Dynamic import for the
 *  same circular-dependency reason as the reload above. */
async function signOutLocal(): Promise<void> {
    try {
        const mod = await import('@/store/auth')
        mod.useAuthStore.getState().handleSessionLost()
    } catch {
        // Best-effort. Without it this tab keeps rendering a signed-in
        // shell until its next request 401s — which is the behaviour
        // this replaces, not a new failure.
    }
}

/** Tell every other tab the session has ended.
 *
 *  Without this a second tab keeps rendering a signed-in shell until
 *  its next request 401s: up to a poll interval if it is visible, and
 *  indefinitely if it is hidden. It would then reach /login through the
 *  session-lost path, which reads to the user as an error rather than
 *  as the sign-out they performed a moment ago in another tab.
 *
 *  Deliberately one-directional. Broadcasting sign-IN would navigate a
 *  tab sitting on /login into the app, which is the auto-restore
 *  behaviour this app has decided against. */
export function notifySignedOut(): void {
    if (!broadcastChannel) return
    try {
        broadcastChannel.postMessage({ kind: 'signed-out' })
    } catch {
        // best-effort — single-tab usage is unaffected.
    }
}

/** Call after the auth store has been updated with new claims AND
 *  React Query has been invalidated. Refreshes the Zustand stores
 *  that hold permission-scoped data, emits a window event for
 *  page-level caches to opt into, AND broadcasts to other tabs so
 *  they catch up without waiting for their next poll. Dynamic imports
 *  avoid the circular dependency that would form if this module
 *  pulled in the stores directly. */
export async function notifyPermissionsChanged(): Promise<void> {
    await notifyPermissionsChangedLocal()
    // 3. Cross-tab broadcast. Other tabs receive the message in
    //    ``onmessage`` above and run ``notifyPermissionsChangedLocal``
    //    — which DOES NOT re-broadcast (preventing a feedback loop).
    if (broadcastChannel) {
        try {
            broadcastChannel.postMessage({ kind: 'changed' })
        } catch {
            // best-effort — single-tab usage continues to work.
        }
    }
}
