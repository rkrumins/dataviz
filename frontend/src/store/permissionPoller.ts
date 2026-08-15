/**
 * Permission poller — closes the "idle user" gap in dynamic RBAC.
 *
 * Background:
 *   The silent refresh-on-401 dance in ``fetchWithTimeout`` already
 *   gives ACTIVE users dynamic permission updates: an admin mutates a
 *   binding → server revokes the user's sid → the user's next API
 *   request 401s → ``fetchWithTimeout`` silently calls
 *   ``/auth/refresh`` → the backend re-resolves DB claims → new JWT
 *   with fresh claims → ``refreshPermissions()`` rehydrates the store.
 *
 *   But that whole chain is request-triggered. A user who is staring
 *   at a page without making API calls never trips the 401, so their
 *   claims stay stale until either (a) they make a request, or (b)
 *   the JWT expires naturally (~5 min). For IDLE users — the typical
 *   "left a workspace open in another tab" case — this poll closes
 *   the gap: every 60 seconds (and immediately on tab focus) we hit
 *   ``/me/permissions``, compare to the cached store, and if the
 *   shape differs we re-hydrate + invalidate React Query so the UI
 *   repaints with fresh state.
 *
 *   The endpoint is purely a JWT decode on the backend (no DB), so
 *   the cost is one tiny GET per minute per active tab — negligible
 *   even at fleet scale.
 *
 * Lifecycle:
 *   * ``enablePermissionPolling()`` — called from ``main.tsx`` once
 *     auth bootstrap has resolved to ``status === 'authenticated'``.
 *   * ``disablePermissionPolling()`` — called when status flips back
 *     to unauthenticated (logout / session lost).
 *   * Tab visibility — hidden tabs pause; a tab returning to focus
 *     forces an immediate poll (catches the case where the user
 *     switched to a long-running session and a mutation happened
 *     while they were away).
 */
import { useAuthStore, claimsSnapshot } from './auth'
import type { PermissionClaims } from '@/services/authService'
import { authService } from '@/services/authService'
import { getQueryClient } from '@/lib/queryClient'
import { notifyPermissionsChanged } from './permissionChangeBus'
import { onAppVisible } from '@/lib/appVisibility'
import { subscribeToUserTopic } from '@/store/changeFeed'

let authReady = false
/** Teardown for the change-topic subscription, or null when not subscribed. */
let unsubscribeTopic: (() => void) | null = null
/** Set SYNCHRONOUSLY before the first await, so a re-entrant caller cannot
 *  start a second read while the first is still in flight.
 *
 *  This used to guard something more dangerous. The refresh was a
 *  self-rescheduling chain, and a chain parked in ``await pollOnce()``
 *  held no timer handle — so a teardown's ``clearTimeout`` had nothing
 *  to cancel, and the parked chain woke up afterwards and re-armed
 *  itself. Every re-entrant enable or tab-focus during an in-flight
 *  request leaked another immortal chain and the request rate climbed
 *  for the lifetime of the tab (the same defect
 *  ``store/providerHealth.ts`` carried).
 *
 *  Nothing re-arms now, so that class of leak is gone by construction.
 *  ``epoch`` still earns its place for the narrower case: a read parked
 *  in its request when the session ends must not apply its result to a
 *  store that has since been torn down. */
let running = false
let epoch = 0
/** JSON-stringified previous claims, used for cheap change detection.
 *  We compare against the LAST POLL'S response — not the store — so
 *  external updates (e.g. from the silent refresh path) don't trip a
 *  false-positive invalidation. */
let lastSnapshot: string = ''

/** Mark every React Query cache as stale so mounted components refetch
 *  and unmounted ones refetch on next mount. We blanket-invalidate
 *  (no key filter) on purpose: enumerating "permission-scoped" keys
 *  would silently drift every time someone adds a new query. The
 *  refetch cost is one wave per permission change — acceptable, and
 *  exactly what users expect after their access shifts. */
function invalidateAllQueries(): void {
    const qc = getQueryClient()
    if (!qc) return
    void qc.invalidateQueries()
}

/** No global perms AND no workspace scopes — i.e. "you can do nothing at all".
 *  A missing claims object counts as empty: "we don't know" is not "you have some". */
function isEmptyClaims(claims: PermissionClaims | undefined | null): boolean {
    if (!claims) return true
    return (claims.global?.length ?? 0) === 0
        && Object.keys(claims.ws ?? {}).length === 0
}

async function pollOnce(): Promise<void> {
    try {
        // This used to be load-bearing for sessions as well as
        // permissions, and it no longer is. Renewal now has its own
        // scheduler (`store/sessionKeepalive.ts`), which rotates ahead of
        // the published expiry instead of relying on this poll happening
        // to be the request that takes the 401.
        //
        // Still do not pass `skipAuthRefresh` here: reactive refresh
        // remains the fallback whenever the keepalive has nothing to
        // schedule against — a session predating the expiry cookie, or a
        // tab whose timers were frozen — and this call is a normal
        // authenticated request that should recover like any other.
        const claims = await authService.myPermissions()

        // NEVER downgrade a real claim set to nothing on the strength of a 200.
        //
        // `hydratePermissions` in store/auth.ts already refuses to do this — the
        // comment there says zeroing claims "blank[ed] the UI" and amplified a
        // request storm. This poller called `setPermissions` DIRECTLY and so
        // bypassed that guard entirely: one odd 200 and every permission-gated
        // control silently vanishes (the Create Workspace button, the provider and
        // ontology summaries, the schema chips on each card), with a full page
        // reload as the only cure.
        //
        // An empty payload is never a legitimate REVOCATION signal here: the
        // endpoint runs `get_current_user`, which checks the revocation set and
        // answers 401 — that path is handled elsewhere. And `get_permission_claims`
        // returns EMPTY claims (200, not 401) for any token without embedded
        // claims. So empty-after-non-empty means "we don't know", not "you have
        // nothing" — and the two must not be rendered the same way.
        const current = useAuthStore.getState().permissions
        if (isEmptyClaims(claims) && !isEmptyClaims(current)) {
            console.warn(
                '[permissions] /me/permissions returned an empty claim set for a user '
                + 'who has permissions. Keeping the known-good claims; not blanking the UI.',
            )
            return
        }

        const next = claimsSnapshot(claims)
        if (next === lastSnapshot) return
        lastSnapshot = next
        useAuthStore.getState().setPermissions(claims)
        invalidateAllQueries()
        // Reload Zustand stores + emit the global change event so
        // surfaces that aren't backed by React Query (CommandPalette
        // workspaces list, page-level useState caches) also refresh.
        // Without this, the auth store gets the new claims but the
        // sidebar keeps showing workspaces the user has just lost.
        void notifyPermissionsChanged()
    } catch {
        // Network / 401 / backend hiccup — swallow. The next tick (or
        // the silent refresh path on a real request) will pick it up.
    }
}

function stopPolling(): void {
    epoch += 1
    running = false
}

/** Re-read the caller's claims, once.
 *
 *  There is no chain any more — nothing re-arms, so nothing can leak a
 *  second one. ``epoch`` still guards the window where a poll is parked
 *  in its request and the session ends underneath it: that poll must not
 *  apply its result to a store that has since been torn down. */
function refreshClaims(): void {
    if (running || !authReady) return
    if (typeof document !== 'undefined' && document.hidden) return
    running = true
    const myEpoch = epoch
    void (async () => {
        try {
            if (myEpoch !== epoch) return
            await pollOnce()
        } finally {
            if (myEpoch === epoch) running = false
        }
    })()
}

/** Call once after auth resolves. Seeds ``lastSnapshot`` from the
 *  already-hydrated store — otherwise the first poll compares against
 *  ``''``, always "detects" a change, and blanket-invalidates every
 *  query on boot. A real mutation between bootstrap and the first
 *  poll still diffs against the seed and invalidates. */
export function enablePermissionPolling(): void {
    authReady = true
    // Idempotent: the app shell calls this from an effect that can re-run (and
    // re-runs on every remount), so a second chain must never be spawned.
    // Checked before seeding — a chain already running owns the snapshot, and
    // overwriting it would make its next poll diff against the wrong baseline.
    if (running) return
    // Seed BEFORE the visibility check, not after. A tab that boots hidden —
    // session restore, cmd-click, opened in the background — used to return
    // here with ``lastSnapshot`` still ``''``, so its first poll after focus
    // compared against the empty string, "detected" a change that had not
    // happened, and ran the unfiltered invalidateAllQueries + cross-tab
    // broadcast. Restoring a window of ten tabs paid that on every one.
    // Seeding is pure state, safe to do while hidden; only the chain waits.
    lastSnapshot = claimsSnapshot(useAuthStore.getState().permissions)
    // An admin changing your bindings is an event, and the backend now
    // publishes it. Subscribe instead of asking every 60 seconds whether
    // it happened — the answer was no essentially every time.
    if (unsubscribeTopic === null) {
        unsubscribeTopic = subscribeToUserTopic('permissions', refreshClaims)
    }
}

/** Call on session loss / logout to stop polling and clear the
 *  snapshot so the next ``enable`` starts cleanly. */
export function disablePermissionPolling(): void {
    authReady = false
    lastSnapshot = ''
    if (unsubscribeTopic) {
        unsubscribeTopic()
        unsubscribeTopic = null
    }
    stopPolling()
}

// Going hidden stays on the raw event: ``onAppVisible`` only fires on the
// way back, and a hidden tab must stop its chain promptly rather than wait
// for anything to coalesce.
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling()
    })
}

// Coming back goes through the shared, coalesced signal. This used to live
// in the same raw listener above, which meant every attention event
// restarted the chain — and a restart is not free here: it polls
// immediately and resets the 60s clock, so rapid window-switching produced
// a request per switch. ``onAppVisible``'s refresh floor bounds that.
onAppVisible(() => {
    if (!authReady) return
    // Re-read on return: the change feed's transport may have been
    // disconnected while the tab was hidden, and this is the moment the
    // user would notice stale claims.
    refreshClaims()
})

// Test-only escape hatch. Tests need to exercise a single tick of
// ``pollOnce`` without waiting for a real setTimeout; the production
// API only exposes ``enable`` / ``disable``. Importing this name from
// non-test code is a smell — use the public surface instead.
export const __pollOnce__ = pollOnce
