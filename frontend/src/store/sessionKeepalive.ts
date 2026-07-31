/**
 * Proactive session renewal.
 *
 * Why this exists:
 *   Refresh used to be purely reactive — fire a request, take the 401,
 *   rotate, replay. Two costs came with that. Every renewal made a
 *   user-visible request pay a full extra round trip, and an idle tab
 *   issues no requests at all, so nothing triggered the renewal.
 *
 *   What actually kept idle tabs alive was the permission poller: its
 *   60-second ``/me/permissions`` call happened to be the request that
 *   took the 401. That worked, but it was an accident. Raising the
 *   poller's interval past the access TTL, giving it ``skipAuthRefresh``,
 *   or removing it would have silently stopped sessions renewing — and
 *   the symptom lands minutes later as a logout with nothing pointing
 *   back at the cause.
 *
 *   So renewal is now explicit. The backend publishes the access
 *   token's expiry in a script-readable cookie (the token itself is
 *   HttpOnly, so the client has no other way to see it); this module
 *   schedules a rotation shortly before that instant and re-arms from
 *   whatever the server published next.
 *
 * What it does NOT do:
 *   Issue its own POST. It calls ``refreshNow()``, the same entry point
 *   the 401 path uses, so both triggers share the in-flight dedupe, the
 *   cross-tab Web Lock, the session-lost latch and the post-refresh
 *   claims comparison. The reactive path stays exactly as it was: this
 *   narrows the window in which it fires, it does not replace it.
 *
 * On the /login route:
 *   Deliberately NOT suppressed, unlike the reactive path's
 *   ``onLoginRoute()`` exemption. That exemption exists to stop a 401 on
 *   /login silently signing someone in, which is a different question
 *   from keeping an already-established session alive. Suppressing here
 *   would expire the session of a user who opened /login to switch
 *   accounts, deliberated for fifteen minutes, and then chose "Continue
 *   as <name>" instead. Renewing costs nothing: rotation authenticates
 *   nobody and signing in as someone else replaces the cookies outright.
 */
import { readAccessExpiryMs, refreshNow, SESSION_REFRESHED_EVENT } from '@/services/fetchWithTimeout'

/**
 * How far ahead of expiry to rotate.
 *
 * Wide enough that a slow or once-retried refresh still lands before
 * the token dies, and wide enough to absorb the backend's own
 * clock-skew leeway. Well short of the 15-minute access TTL, so this
 * does not meaningfully shorten token lifetime — roughly one extra
 * rotation per session.
 */
const RENEW_BEFORE_MS = 60_000

/**
 * Floor on the scheduling delay.
 *
 * Two jobs. It keeps an already-expired session from renewing in a
 * zero-delay loop, and it gives the cookie write from a refresh in
 * another tab time to land before we re-read it.
 */
const MIN_DELAY_MS = 2_000

/**
 * How long to wait before re-arming when the server published nothing
 * to schedule against — a session that predates the expiry cookie, or
 * one whose cookie was dropped. The reactive 401 path still covers this
 * tab; we just check back periodically in case a rotation has since
 * published an expiry we can use.
 */
const REARM_PROBE_MS = 60_000

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
/** Invalidates timers owned by a previous enable/disable cycle, exactly
 *  as the permission poller does — a callback that has already been
 *  queued cannot be cancelled, only ignored. */
let epoch = 0
let listenersBound = false

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * Rotate, then re-arm.
 *
 * Outcomes other than ``expired`` re-arm: ``ok`` schedules against the
 * new expiry, and ``retryable`` (429, 5xx, offline) tells us nothing
 * about the session, so we try again on the probe interval rather than
 * giving up on renewal for the life of the tab.
 */
async function renew(myEpoch: number): Promise<void> {
  if (myEpoch !== epoch) return
  const before = readAccessExpiryMs()
  let outcome: Awaited<ReturnType<typeof refreshNow>>
  try {
    outcome = await refreshNow()
  } catch {
    outcome = 'retryable'
  }
  if (myEpoch !== epoch) return
  if (outcome === 'expired' || outcome === 'reauth') {
    // 'expired' — the 401 handler has already announced the lost
    // session and the store is signing out; scheduling another rotation
    // would just re-ask a settled question. 'reauth' — we are mid-bounce
    // to the IdP and this document is about to be replaced.
    return
  }
  // Did that rotation actually buy us anything? If the published expiry
  // has not moved — a backend too old to publish it, a cookie the
  // browser refused, a refresh that reported success without rotating —
  // then scheduling off it again lands on the floor delay and renews on
  // a loop, which is a request storm aimed at our own auth endpoint.
  // Back off to the probe interval instead and let the reactive path
  // carry the session.
  const after = readAccessExpiryMs()
  const advanced = after !== null && (before === null || after > before)
  schedule(myEpoch, advanced ? undefined : REARM_PROBE_MS)
}

/**
 * Arm the next rotation from whatever expiry the server last published.
 *
 * ``floorMs`` raises the minimum delay for this one hop, so a caller
 * that knows the last attempt achieved nothing can slow the cadence
 * without changing how the expiry is read.
 */
function schedule(myEpoch: number, floorMs: number = MIN_DELAY_MS): void {
  if (myEpoch !== epoch || !running) return
  clearTimer()

  const expiryMs = readAccessExpiryMs()
  const delay =
    expiryMs === null
      ? Math.max(floorMs, REARM_PROBE_MS)
      : Math.max(floorMs, expiryMs - RENEW_BEFORE_MS - Date.now())

  timer = setTimeout(() => {
    if (myEpoch !== epoch) return
    // Re-read rather than trusting the delay we computed: another tab
    // may have rotated while this timer was pending (cookies are shared
    // across tabs), in which case there is nothing to do but re-arm
    // against the newer expiry.
    const current = readAccessExpiryMs()
    if (current !== null && current - RENEW_BEFORE_MS - Date.now() > MIN_DELAY_MS) {
      schedule(myEpoch)
      return
    }
    if (current === null) {
      // Still nothing published — keep probing rather than renewing
      // blind. A refresh here would be a POST we have no reason to
      // believe is due.
      schedule(myEpoch)
      return
    }
    void renew(myEpoch)
  }, delay)
}

/** Re-arm against the expiry a just-completed refresh published. */
function onSessionRefreshed(): void {
  if (!running) return
  schedule(epoch)
}

/**
 * A backgrounded tab's timers are throttled to roughly one tick a
 * minute, and a discarded or frozen tab's may not run at all — so a
 * renewal slot can pass unserved while hidden. Re-evaluating on the way
 * back to visible turns that into an immediate rotation instead of a
 * 401 on whatever the user clicks first.
 *
 * Note this is the opposite posture to the permission poller, which
 * stops while hidden. Permissions can wait for the user to look;
 * a session cannot, because the refresh window closes whether anyone
 * is watching or not.
 */
function onVisibilityChange(): void {
  if (!running) return
  if (typeof document !== 'undefined' && document.hidden) return
  schedule(epoch)
}

function bindListeners(): void {
  if (listenersBound || typeof window === 'undefined') return
  window.addEventListener(SESSION_REFRESHED_EVENT, onSessionRefreshed)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  listenersBound = true
}

/**
 * Start renewing. Idempotent — the app shell calls this from an effect
 * that re-runs, and a second call must not produce a second timer chain.
 */
export function enableSessionKeepalive(): void {
  if (running) return
  running = true
  bindListeners()
  schedule(epoch)
}

/** Stop renewing. Called on logout and on a lost session. */
export function disableSessionKeepalive(): void {
  epoch += 1
  running = false
  clearTimer()
}
