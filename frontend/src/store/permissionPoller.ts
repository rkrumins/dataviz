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
import { useAuthStore } from './auth'
import { authService, type PermissionClaims } from '@/services/authService'
import { getQueryClient } from '@/main'
import { POLLING_INTERVALS, withJitter } from '@/config/polling'

const POLL_INTERVAL_MS = POLLING_INTERVALS.permissions

let pollTimer: ReturnType<typeof setTimeout> | null = null
let authReady = false
/** JSON-stringified previous claims, used for cheap change detection.
 *  We compare against the LAST POLL'S response — not the store — so
 *  external updates (e.g. from the silent refresh path) don't trip a
 *  false-positive invalidation. */
let lastSnapshot: string = ''

/** Canonical JSON for a claims object — sorts arrays + object keys so
 *  semantically-equal payloads compare equal regardless of key order
 *  or perm order. Used as the cheap change detector. */
function snapshot(claims: PermissionClaims): string {
    const wsKeys = Object.keys(claims.ws).sort()
    return JSON.stringify({
        global: [...claims.global].sort(),
        ws: wsKeys.reduce<Record<string, string[]>>((acc, k) => {
            acc[k] = [...claims.ws[k]].sort()
            return acc
        }, {}),
    })
}

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
    try {
        const claims = await authService.myPermissions()
        const next = snapshot(claims)
        if (next === lastSnapshot) return
        lastSnapshot = next
        useAuthStore.getState().setPermissions(claims)
        invalidateAllQueries()
    } catch {
        // Network / 401 / backend hiccup — swallow. The next tick (or
        // the silent refresh path on a real request) will pick it up.
    }
}

function scheduleNext(): void {
    if (!authReady || typeof document === 'undefined' || document.hidden) return
    pollTimer = setTimeout(async () => {
        await pollOnce()
        scheduleNext()
    }, withJitter(POLL_INTERVAL_MS))
}

function stopPolling(): void {
    if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
    }
}

/** Call once after auth resolves. Fires an immediate first poll to
 *  establish ``lastSnapshot``, then schedules the next tick. */
export function enablePermissionPolling(): void {
    authReady = true
    if (typeof document !== 'undefined' && document.hidden) return
    stopPolling()
    void (async () => {
        await pollOnce()
        scheduleNext()
    })()
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
        // resume the regular cadence.
        stopPolling()
        void (async () => {
            await pollOnce()
            scheduleNext()
        })()
    })
}
