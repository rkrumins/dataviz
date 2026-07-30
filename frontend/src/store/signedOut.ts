/**
 * "I signed out" as a fact the client remembers, not just a server state.
 *
 * Two things could sign a user back in without them typing anything:
 *
 *   1. The refresh cookie. Any route with a live one silently restores the
 *      session — which is the behaviour that keeps a long-lived tab
 *      usable, and is right for an ordinary expiry.
 *   2. A ``custom_profile`` payload sitting in browser storage. The login
 *      page reads it and mints a NEW session from it. Server-side
 *      revocation cannot touch that: it isn't presenting a credential the
 *      server has condemned, it is asking for a fresh one.
 *
 * After an EXPLICIT sign-out, neither should happen. Signing out already
 * revokes the refresh family and tombstones the access session, so (1) is
 * mostly covered by the server — this marker closes the window before
 * that lands and makes the intent legible on the client. (2) is only
 * covered here.
 *
 * Deliberately scoped to explicit sign-out. An ordinary token expiry must
 * still restore silently, or every user is dragged through an interactive
 * login on a schedule, and the "leave it open and come back" case — the
 * one this whole change is about — breaks in a new way.
 *
 * localStorage, not sessionStorage: the portal payload is read by any tab,
 * so a per-tab marker would let a new tab sign you straight back in.
 */

const KEY = 'nx_signed_out'

function storage(): Storage | null {
    // Private browsing, SSR, and tests-without-DOM all make this throw or
    // vanish. A missing marker must never break sign-in or sign-out.
    if (typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

/** Record that the user asked to be signed out. */
export function markSignedOut(): void {
    try {
        storage()?.setItem(KEY, '1')
    } catch {
        // Quota or private-mode rejection. Worst case we fall back to the
        // pre-existing behaviour, which the server-side revocation still
        // covers for the refresh path.
    }
}

/** Clear the marker — called on every successful sign-in. */
export function clearSignedOut(): void {
    try {
        storage()?.removeItem(KEY)
    } catch {
        // ignore
    }
}

/** True while the user has signed out and not signed back in. */
export function isSignedOut(): boolean {
    try {
        return storage()?.getItem(KEY) === '1'
    } catch {
        return false
    }
}
