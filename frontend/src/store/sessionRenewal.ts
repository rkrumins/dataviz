/**
 * Proactive session renewal — rotate the token before it dies.
 *
 * Renewal used to be entirely reactive: something had to 401 first, and
 * ``fetchWithTimeout`` would recover from it. That works for a user who
 * is clicking around, and not at all for the case people actually
 * reported — a page left open for a long time. Nothing was scheduled, so
 * the only authenticated request still firing in an idle tab was the
 * 60-second permission poll, which is *also* what kept the session alive
 * as a side effect. And that poll pauses while the tab is hidden. So a
 * backgrounded tab had no renewal at all, and coming back to it meant
 * discovering the expiry through whatever request happened to fire first
 * — sometimes recovering silently, sometimes landing on the login page.
 *
 * Now the server tells us when the token expires (``accessExpiresAt`` on
 * ``GET /me/session``) and we renew ahead of it. The 401 path stays as
 * the fallback it should always have been: for clock skew, for a
 * suspended machine, for a renewal that failed.
 *
 * Deliberately NOT tied to tab visibility. Browsers throttle timers in
 * background tabs to roughly once a minute, which is far finer than the
 * renewal cadence needs, so a hidden tab keeps its session — which is the
 * whole point.
 */

import { authService } from '@/services/authService'

/**
 * Renew at this fraction of the token's remaining life.
 *
 * 0.7 leaves ~30% of the window as slack for a slow or failed rotation to
 * be retried inside, while still being late enough that a short-lived tab
 * never rotates at all.
 */
const RENEW_AT_FRACTION = 0.7

/**
 * Never schedule closer than this. A token that is already expiring
 * should be rotated promptly, but a zero-delay timer during a render
 * cascade is a way to fire several rotations at once.
 */
const MIN_DELAY_MS = 2_000

/**
 * Never schedule further out than this, whatever the token claims.
 * Bounds the damage from a malformed or absurd ``exp`` — and a timer this
 * long is one a suspended laptop will miss anyway, which the 401 fallback
 * then covers.
 */
const MAX_DELAY_MS = 30 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null
/** Invalidates a rotation already parked in flight. See ``cancel``. */
let epoch = 0

/**
 * Consecutive rotations triggered by ``staleClaims``.
 *
 * A rotation re-mints the token from the same resolver ``/me/session``
 * read, so one attempt should always clear the disagreement. If it does
 * not, the two sides differ for a structural reason a rotation cannot fix
 * — and rotating on every poll would then be an unbounded loop against
 * the auth endpoint, which is exactly the kind of self-inflicted request
 * storm this whole change is meant to end. So we try once, then leave it
 * alone and say so.
 */
let staleRotations = 0
const MAX_STALE_ROTATIONS = 1

/** How long to wait before renewing a token that expires at *iso*. */
export function renewalDelayMs(iso: string | null, now: number): number | null {
    if (!iso) return null
    const expiresAt = Date.parse(iso)
    if (Number.isNaN(expiresAt)) return null
    const remaining = expiresAt - now
    // Already expired, or so close that renewing "early" is meaningless:
    // let the reactive 401 path handle it rather than racing it.
    if (remaining <= MIN_DELAY_MS) return null
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, remaining * RENEW_AT_FRACTION))
}

/**
 * Schedule a renewal for a token expiring at *accessExpiresAt*.
 *
 * Idempotent by replacement: every resolved session calls this, and the
 * newest expiry is the only one that matters, so the previous timer is
 * always dropped. That is also what stops a rotation storm — N resolves
 * leave one timer, not N.
 */
export function scheduleSessionRenewal(accessExpiresAt: string | null): void {
    cancelSessionRenewal()
    const delay = renewalDelayMs(accessExpiresAt, Date.now())
    if (delay === null) return
    const myEpoch = epoch
    timer = setTimeout(() => {
        if (myEpoch !== epoch) return
        void renewNow(myEpoch)
    }, delay)
}

/**
 * Stop renewing. Called on logout and on a lost session.
 *
 * Bumps the epoch as well as clearing the timer: a rotation already
 * awaiting the network holds no timer handle, so ``clearTimeout`` cannot
 * reach it, and without the epoch it would wake up afterwards and
 * schedule its own successor — resurrecting renewal for a session that
 * has ended.
 */
export function cancelSessionRenewal(): void {
    epoch += 1
    if (timer !== null) {
        clearTimeout(timer)
        timer = null
    }
}

/**
 * Everything a freshly resolved session implies. The store's single call
 * into this module.
 *
 * Two decisions, both taken from fields the server volunteered, and both
 * kept here so the ordering between them is stated once:
 *
 *   * arm the next renewal from ``accessExpiresAt``;
 *   * rotate now if ``staleClaims`` — the database and the token disagree
 *     about what this user may do. The UI is already showing the
 *     database's answer, so this is not about what they can see; it is
 *     about ``requires(...)``, which reads the token, and would otherwise
 *     403 a control we have just shown them.
 *
 * The stale-rotation budget resets only on a resolve that came back in
 * agreement. Resetting it on every resolve — the obvious place, inside
 * ``scheduleSessionRenewal`` — would hand a fresh budget to the very
 * resolve that reported the disagreement, and the cap would never bite.
 */
export function onSessionResolved(state: {
    accessExpiresAt: string | null
    staleClaims: boolean
}): void {
    scheduleSessionRenewal(state.accessExpiresAt)
    if (!state.staleClaims) {
        staleRotations = 0
        return
    }
    if (staleRotations >= MAX_STALE_ROTATIONS) {
        console.warn(
            '[session] the database and the access token still disagree after '
            + 'a rotation. Not rotating again — the UI shows the database\'s '
            + 'answer, but the API may refuse a control until the next sign-in.',
        )
        return
    }
    staleRotations += 1
    void renewNow(epoch)
}

/**
 * One rotation, then re-resolve so the store picks up the new expiry and
 * schedules the next renewal.
 *
 * Failures are deliberately quiet. A rotation that could not happen is
 * not a session that has ended — the token is still valid until its
 * ``exp``, and the reactive 401 path is still there. Signing the user out
 * here on a network blip is precisely the over-reaction that used to log
 * people out at random.
 */
async function renewNow(myEpoch: number): Promise<void> {
    try {
        await authService.refresh()
    } catch {
        // Leave the session alone; the 401 path will deal with it if the
        // token really is gone. No reschedule: this token's renewal
        // window is spent, and the next successful resolve re-arms.
        return
    }
    if (myEpoch !== epoch) return
    const mod = await import('@/store/auth')
    // Re-resolve, not just re-read claims: we need the NEW accessExpiresAt
    // to arm the next timer, and refreshPermissions is the one entry point
    // that goes through the single applyClaims policy.
    await mod.useAuthStore.getState().refreshPermissions({ skipAuthRefresh: true })
}

/** Test-only: the renewal the timer would run, without waiting for it. */
export const __renewNow__ = () => renewNow(epoch)
