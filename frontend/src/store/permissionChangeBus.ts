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

/** Call after the auth store has been updated with new claims AND
 *  React Query has been invalidated. Refreshes the Zustand stores
 *  that hold permission-scoped data, and emits a window event for
 *  page-level caches to opt into. Dynamic imports avoid the circular
 *  dependency that would form if this module pulled in the stores
 *  directly (some of those stores import from this one transitively). */
export async function notifyPermissionsChanged(): Promise<void> {
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
