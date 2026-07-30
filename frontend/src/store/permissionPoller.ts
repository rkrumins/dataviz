/**
 * Session poller — closes the "idle user" gap in dynamic RBAC.
 *
 * Background:
 *   The silent refresh-on-401 dance in ``fetchWithTimeout`` gives ACTIVE
 *   users dynamic permission updates, but that whole chain is
 *   request-triggered. A user staring at a page without making API calls
 *   never trips the 401. This poll closes the gap: every 60 seconds (and
 *   immediately on tab focus) we resolve ``GET /me/session``, compare to
 *   our last answer, and if it differs we apply it and invalidate React
 *   Query so the UI repaints.
 *
 *   IT USED TO POLL ``/me/permissions``, WHICH COULD NOT DO THIS JOB.
 *   That endpoint re-reads the claims out of the access token, so polling
 *   it returned the same answer every time until the token happened to
 *   rotate — the change this poller exists to notice was invisible to the
 *   request it made to notice it. ``/me/session`` resolves from the
 *   database, so a grant or a demotion lands within one interval. The
 *   cost moved with it: this is a real query now, not a token decode.
 *
 *   IT ALSO USED TO BE THE THING KEEPING THE SESSION ALIVE — the only
 *   authenticated request still firing in an idle tab, so its 401 was
 *   what drove renewal. That was load-bearing and undocumented anywhere
 *   near the code that depended on it, and it failed in the obvious
 *   place: polling stops while the tab is hidden, so a backgrounded tab
 *   renewed nothing. Renewal is now scheduled deliberately in
 *   ``store/sessionRenewal.ts``, and this module is free to be only what
 *   its name says.
 *
 * Lifecycle:
 *   * ``enablePermissionPolling()`` — called from ``App.tsx`` once auth
 *     bootstrap has resolved to ``status === 'authenticated'``.
 *   * ``disablePermissionPolling()`` — called when status flips back
 *     to unauthenticated (logout / session lost).
 *   * Tab visibility — hidden tabs pause; a tab returning to focus
 *     forces an immediate poll (catches the case where the user
 *     switched to a long-running session and a mutation happened
 *     while they were away).
 */
import { useAuthStore, claimsSnapshot } from './auth'
import { getQueryClient } from '@/lib/queryClient'
import { POLLING_INTERVALS, withJitter } from '@/config/polling'
import { notifyPermissionsChanged } from './permissionChangeBus'

const POLL_INTERVAL_MS = POLLING_INTERVALS.permissions

let pollTimer: ReturnType<typeof setTimeout> | null = null
let authReady = false
/** Set SYNCHRONOUSLY before the first await, so a re-entrant caller cannot
 *  start a second chain while the first is still in flight. `epoch` invalidates
 *  a chain that is parked in ``await pollOnce()``: such a chain holds no timer
 *  handle, so ``stopPolling()``'s ``clearTimeout`` has nothing to cancel, and
 *  without the epoch it wakes up afterwards and calls ``scheduleNext()``,
 *  resurrecting itself. Same defect as ``store/providerHealth.ts`` — every
 *  re-entrant enable / tab-focus during an in-flight request permanently leaked
 *  another immortal, self-rescheduling chain, and the request rate climbed for
 *  the lifetime of the tab. */
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

async function pollOnce(): Promise<void> {
    // One entry point, one policy. This used to call ``setPermissions``
    // directly and so carried its own opinion about an empty claim set —
    // an opinion that contradicted the store's. Both were guesses forced
    // by an endpoint that could not distinguish "holds nothing" from
    // "couldn't tell"; ``/me/session`` can, so ``applyClaims`` decides,
    // here and everywhere else.
    //
    // Not passed ``skipAuthRefresh``: a poll landing on an expired token
    // should still recover through the silent-refresh path. Renewal no
    // longer DEPENDS on that (see the module docstring), but there is no
    // reason to refuse a free recovery. Errors are swallowed inside
    // ``refreshPermissions``, which keeps the last known-good claims — so
    // an outage leaves the snapshot unchanged and triggers nothing.
    await useAuthStore.getState().refreshPermissions()

    const next = claimsSnapshot(useAuthStore.getState().permissions)
    if (next === lastSnapshot) return
    lastSnapshot = next
    invalidateAllQueries()
    // Reload Zustand stores + emit the global change event so
    // surfaces that aren't backed by React Query (CommandPalette
    // workspaces list, page-level useState caches) also refresh.
    // Without this, the auth store gets the new claims but the
    // sidebar keeps showing workspaces the user has just lost.
    void notifyPermissionsChanged()
}

function scheduleNext(myEpoch: number): void {
    if (myEpoch !== epoch) return
    if (!authReady || typeof document === 'undefined' || document.hidden) return
    pollTimer = setTimeout(async () => {
        if (myEpoch !== epoch) return
        await pollOnce()
        scheduleNext(myEpoch)
    }, withJitter(POLL_INTERVAL_MS))
}

function stopPolling(): void {
    epoch += 1
    running = false
    if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
    }
}

/** Start exactly one poll chain: fire now, then resume the jittered cadence.
 *  Idempotent — a chain that is already running, INCLUDING one parked in an
 *  in-flight request, is left alone rather than duplicated. */
function startChain(): void {
    if (running || !authReady) return
    if (typeof document !== 'undefined' && document.hidden) return
    running = true
    const myEpoch = epoch
    void (async () => {
        if (myEpoch !== epoch) return
        await pollOnce()
        scheduleNext(myEpoch)
    })()
}

/** Call once after auth resolves. Seeds ``lastSnapshot`` from the
 *  already-hydrated store — otherwise the first poll compares against
 *  ``''``, always "detects" a change, and blanket-invalidates every
 *  query on boot. A real mutation between bootstrap and the first
 *  poll still diffs against the seed and invalidates.
 *
 *  "Already-hydrated" is a real precondition, not a description: the
 *  caller must wait for the first resolve to SETTLE. ``status`` flips to
 *  ``authenticated`` from the sessionStorage user cache while claims are
 *  still in flight, so enabling on ``status`` alone seeded the snapshot
 *  from an empty store, and the first poll then "detected" a change that
 *  had not happened — an unfiltered ``invalidateQueries`` plus a
 *  cross-tab broadcast on every warm reload. ``App.tsx`` gates on
 *  ``permissionsStatus`` for exactly this reason. */
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
    if (typeof document !== 'undefined' && document.hidden) return
    startChain()
}

/** Call on session loss / logout to stop polling and clear the
 *  snapshot so the next ``enable`` starts cleanly. */
export function disablePermissionPolling(): void {
    authReady = false
    lastSnapshot = ''
    stopPolling()
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling()
            return
        }
        if (!authReady) return
        // Tab returned to focus — poll immediately so the user sees
        // any mutation that happened while they were away, then
        // resume the regular cadence. stopPolling() bumps the epoch, which
        // retires any chain still parked in an in-flight request, so
        // startChain() below leaves exactly one chain running — not one more.
        stopPolling()
        startChain()
    })
}

// Test-only escape hatch. Tests need to exercise a single tick of
// ``pollOnce`` without waiting for a real setTimeout; the production
// API only exposes ``enable`` / ``disable``. Importing this name from
// non-test code is a smell — use the public surface instead.
export const __pollOnce__ = pollOnce
