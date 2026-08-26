/**
 * Silent recovery for back-channel sessions.
 *
 * The corporate session behind a gateway sign-in expires on its own
 * schedule — an hour, four hours — and when it does, our next refresh
 * answers 401 `sso_reauth_required`. Before this module, that envelope
 * was handled by navigating to the server-side login leg: a full page
 * load that, for the very reason the session ended, had no cookie to
 * read, failed, and landed the user on /login — where a once-per-tab
 * sentinel blocked the automatic retry. The first expiry of the day
 * cost every user their place in the app.
 *
 * This module closes the loop where the capability actually lives: in
 * the browser, which can mint a fresh corporate session the same way
 * the sign-in page did. Called from `attemptRefresh`'s reauth branch —
 * inside the in-flight dedupe AND the cross-tab Web Lock, so N tabs
 * produce one recovery, and the tabs that lost the lock read the moved
 * expiry cookie as their answer. On success the original request
 * retries as if the 401 never happened; nothing navigates, nothing
 * flashes.
 *
 * A failure latches for {@link REAUTH_COOLDOWN_MS} (module state AND
 * sessionStorage, so a bounce to /login sees it too): a corporate IdP
 * that is genuinely down must not be hammered once per access lifetime,
 * and the user must land on a visible form with the reason — not in a
 * loop. Every path terminates: recovered, or signed out with an
 * explanation.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import {
    loginWithBackchannel,
    needsAuthenticateFirst,
    needsBrowserExchange,
    runAuthenticateTrigger,
    runBrowserExchange,
    type AuthUser,
    type LoginContext,
    type SsoProviderSummary,
} from './authService'

export type SilentReauthResult =
    | 'recovered' | 'failed' | 'not-applicable' | 'gone'

/** How long a failed recovery suppresses the next automatic attempt —
 *  both here and on the login page's own silent sign-in. */
export const REAUTH_COOLDOWN_MS = 60_000

const FAILURE_MARKER = 'nx_bc_reauth_failed'

/** The login page's silent-attempt sentinel. Owned here rather than in
 *  the page because recovery is the other writer: a successful silent
 *  re-sign-in must clear it, or the next genuine bounce to /login would
 *  find it spent and sit on the form. */
const AUTO_SENTINEL = 'nx_portal_autologin_tried'

let failedAtInMemory: number | null = null

function readFailureMarker(): { at: number; reason: string } | null {
    try {
        const raw = window.sessionStorage.getItem(FAILURE_MARKER)
        if (!raw) return null
        const parsed = JSON.parse(raw) as { at?: unknown; reason?: unknown }
        if (typeof parsed.at !== 'number') return null
        return { at: parsed.at, reason: String(parsed.reason ?? '') }
    } catch {
        return null
    }
}

/** The current failure, or null once the cooldown has lapsed. The login
 *  page reads this to show the reason and to hold its silent attempt. */
export function readReauthFailure(): { at: number; reason: string } | null {
    const marker = readFailureMarker()
    if (marker && Date.now() - marker.at < REAUTH_COOLDOWN_MS) return marker
    if (
        failedAtInMemory !== null
        && Date.now() - failedAtInMemory < REAUTH_COOLDOWN_MS
    ) {
        return { at: failedAtInMemory, reason: '' }
    }
    return null
}

export function clearReauthFailure(): void {
    failedAtInMemory = null
    try {
        window.sessionStorage.removeItem(FAILURE_MARKER)
    } catch {
        // storage unavailable — the in-memory latch is already cleared
    }
}

function markReauthFailure(reason: string): void {
    failedAtInMemory = Date.now()
    try {
        window.sessionStorage.setItem(
            FAILURE_MARKER,
            JSON.stringify({ at: failedAtInMemory, reason }),
        )
    } catch {
        // storage unavailable — the in-memory latch still holds this tab
    }
}

/** True while the login page's silent attempt should stay quiet: it ran
 *  recently, or a recovery just failed. Time-based rather than forever —
 *  the old boolean sentinel meant the second expiry of the day landed
 *  every long-lived tab on the form for good. */
export function autoPortalAlreadyTried(): boolean {
    if (readReauthFailure() !== null) return true
    try {
        const at = Number(window.sessionStorage.getItem(AUTO_SENTINEL))
        return Number.isFinite(at) && at > 0
            && Date.now() - at < REAUTH_COOLDOWN_MS
    } catch {
        return false
    }
}

export function markAutoPortalTried(): void {
    try {
        window.sessionStorage.setItem(AUTO_SENTINEL, String(Date.now()))
    } catch {
        // storage unavailable — the page's in-flight ref still guards
        // the render loop
    }
}

function clearAutoPortalSentinel(): void {
    try {
        window.sessionStorage.removeItem(AUTO_SENTINEL)
    } catch {
        // best-effort
    }
}

async function resolveProvider(
    slug: string,
): Promise<SsoProviderSummary | null> {
    // Straight through fetchWithTimeout with skipAuthRefresh, not the
    // authService wrapper: this runs INSIDE the refresh machinery, and
    // nothing called from here may re-enter it.
    const res = await fetchWithTimeout('/api/v1/auth/login-context', {
        credentials: 'include',
        skipAuthRefresh: true,
    })
    if (!res.ok) throw new Error(`login-context answered ${res.status}`)
    const ctx = (await res.json()) as LoginContext
    return ctx.providers?.find((p) => p.slug === slug) ?? null
}

async function hydrateAfterRecovery(user: AuthUser | undefined): Promise<void> {
    // Mirrors the post-refresh block in fetchWithTimeout: the app never
    // noticed the session die, so only the caches need to catch up.
    // Everything is best-effort — the recovered session is already real.
    if (user) {
        try {
            const mod = await import('@/store/userCache')
            mod.writeUserCache(user)
        } catch {
            // best-effort
        }
    }
    try {
        const mod = await import('@/store/auth')
        await mod.useAuthStore.getState().refreshPermissions({
            skipAuthRefresh: true,
        })
    } catch {
        // best-effort
    }
    try {
        const busMod = await import('@/store/permissionChangeBus')
        await busMod.notifyPermissionsChanged()
    } catch {
        // best-effort
    }
}

/**
 * Re-run the browser's half of the sign-in and complete it in place.
 *
 * `'recovered'` — a fresh session exists; the caller reports the refresh
 * as having succeeded. `'failed'` — the browser's half was tried (or is
 * in cooldown) and did not produce a session; the caller signs out, and
 * the login page explains. `'not-applicable'` — this provider has no
 * browser half to run, or could not be resolved; the caller keeps its
 * existing navigation behaviour. `'gone'` — the catalog answered and
 * this slug is not in it (the connection was disabled or deleted, or
 * the master switch is off); the caller must land on the login PAGE,
 * because the provider's own login URL is now a dead route.
 */
export async function attemptSilentReauth(
    providerSlug: string | undefined,
): Promise<SilentReauthResult> {
    if (!providerSlug || typeof window === 'undefined') return 'not-applicable'
    if (readReauthFailure() !== null) return 'failed'

    let provider: SsoProviderSummary | null
    try {
        provider = await resolveProvider(providerSlug)
    } catch {
        // Could not even ask which provider this is. Not a verdict about
        // the corporate session — keep the navigation fallback.
        return 'not-applicable'
    }
    if (!provider) {
        // The catalog answered, and the connection this session came
        // from is not in it any more. A verdict, not an outage: latch
        // the reason so the login page can say it, instead of the raw
        // 404 the dead login URL used to serve.
        markReauthFailure(
            'This sign-in method is no longer available. '
            + 'Ask your administrator how to sign in now.',
        )
        return 'gone'
    }
    if (provider.kind !== 'backchannel') return 'not-applicable'
    if (!needsAuthenticateFirst(provider) && !needsBrowserExchange(provider)) {
        // No browser half is published — a plain ambient row whose
        // corporate session may well still be alive. The server-leg
        // navigation covers that case; nothing here would add to it.
        return 'not-applicable'
    }

    try {
        let body: { handle?: string; assertion?: string } = {}
        if (needsBrowserExchange(provider)) {
            if (needsAuthenticateFirst(provider)) {
                await runAuthenticateTrigger(provider)
            }
            body = { assertion: await runBrowserExchange(provider) }
        } else {
            const handle = await runAuthenticateTrigger(provider)
            body = handle ? { handle } : {}
        }
        const { user } = await loginWithBackchannel(provider.slug, body, {
            skipAuthRefresh: true,
        })
        await hydrateAfterRecovery(user)
        clearReauthFailure()
        clearAutoPortalSentinel()
        return 'recovered'
    } catch (err) {
        markReauthFailure(
            err instanceof Error ? err.message : 'The sign-in did not work.',
        )
        return 'failed'
    }
}
