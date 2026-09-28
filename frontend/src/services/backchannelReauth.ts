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
 * A definitive failure latches for {@link REAUTH_COOLDOWN_MS} (module
 * state AND localStorage, so a bounce to /login — in any tab — sees it
 * too): a corporate IdP that is genuinely down must not be hammered once
 * per access lifetime, and the user must land on a visible form with the
 * reason — not in a loop. A transient one (either call answering 429 /
 * 5xx, or not at all, or the whole attempt outrunning its deadline) is
 * retried once and does not latch; its reason is still shown. Every path
 * terminates: recovered, or on the sign-in page with an explanation.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import {
    BackchannelLoginError,
    GatewayCallError,
    loginWithBackchannel,
    type AuthUser,
    type LoginContext,
    type SsoProviderSummary,
} from './authService'
import { gatewaySignInBody, isGatewayProvider } from './gatewayFlow'

export type SilentReauthResult =
    | 'recovered' | 'failed' | 'not-applicable' | 'gone'

/** How long a failed recovery suppresses the next automatic attempt —
 *  both here and on the login page's own silent sign-in. */
export const REAUTH_COOLDOWN_MS = 60_000

/** The last failed recovery. In localStorage, not sessionStorage: every
 *  tab that lands on the sign-in page shows the same reason, and none of
 *  them re-runs the browser half against a corporate host that just said
 *  no — per tab, only the tab that ran the recovery knew, and a restored
 *  browser session re-ran it once per tab. Bounded by
 *  {@link REAUTH_COOLDOWN_MS}, so an entry that outlives a restart is
 *  ignored. */
const FAILURE_MARKER = 'nx_bc_reauth_failed'

/** The login page's silent-attempt sentinel. Owned here rather than in
 *  the page because recovery is the other writer: a successful silent
 *  re-sign-in must clear it, or the next genuine bounce to /login would
 *  find it spent and sit on the form. */
const AUTO_SENTINEL = 'nx_portal_autologin_tried'

/** Set by an explicit sign-out, cleared by the next sign-in. In
 *  localStorage, not sessionStorage: every tab of the app shares it, so a
 *  new tab — or a reload a minute later — cannot sign someone straight
 *  back in with the corporate session they just signed out in front of.
 *  A session that merely EXPIRED never sets it, so silent renewal is
 *  untouched. */
const SIGNED_OUT_MARKER = 'nx_signed_out'

/** How long to wait before the one retry of a transient failure, before
 *  jitter — long enough for a Retry-After-sized pause to clear, short
 *  enough that nobody watching notices. */
const TRANSIENT_RETRY_MS = 1_000

/** The most one silent re-sign-in may take, retry included. It runs inside
 *  the cross-tab refresh lock, so every tab's requests wait on it; its own
 *  calls' timeouts added up to over two minutes. Past this it is a
 *  failure that says nothing about the corporate session, and the sign-in
 *  page's automatic attempt takes over. */
const REAUTH_DEADLINE_MS = 45_000

/** A failed recovery, as the sign-in page explains it. ``hold`` is false
 *  when nothing was learned about the corporate session — load, the
 *  network, the deadline — so the reason is shown but no automatic
 *  attempt is held back by it. */
export type ReauthFailure = { at: number; reason: string; hold: boolean }

let failedAtInMemory: number | null = null

function readFailureMarker(): ReauthFailure | null {
    try {
        const raw = window.localStorage.getItem(FAILURE_MARKER)
        if (!raw) return null
        const parsed = JSON.parse(raw) as {
            at?: unknown; reason?: unknown; hold?: unknown
        }
        if (typeof parsed.at !== 'number') return null
        return {
            at: parsed.at,
            reason: String(parsed.reason ?? ''),
            hold: parsed.hold !== false,
        }
    } catch {
        return null
    }
}

/** The failure that holds automatic attempts back, or null once the
 *  cooldown has lapsed. A failure that was only load or the network
 *  never holds anything — see {@link readReauthNotice}. */
export function readReauthFailure(): { at: number; reason: string } | null {
    const marker = readReauthNotice()
    if (marker?.hold) return { at: marker.at, reason: marker.reason }
    if (
        failedAtInMemory !== null
        && Date.now() - failedAtInMemory < REAUTH_COOLDOWN_MS
    ) {
        return { at: failedAtInMemory, reason: '' }
    }
    return null
}

/** Any recent failure, holding or not: what the sign-in page says to
 *  someone who just landed there from a renewal that did not work. */
export function readReauthNotice(): ReauthFailure | null {
    const marker = readFailureMarker()
    return marker && Date.now() - marker.at < REAUTH_COOLDOWN_MS ? marker : null
}

export function clearReauthFailure(): void {
    failedAtInMemory = null
    try {
        window.localStorage.removeItem(FAILURE_MARKER)
    } catch {
        // storage unavailable — the in-memory latch is already cleared
    }
}

function markReauthFailure(
    reason: string, { hold = true }: { hold?: boolean } = {},
): void {
    const at = Date.now()
    if (hold) failedAtInMemory = at
    try {
        window.localStorage.setItem(
            FAILURE_MARKER, JSON.stringify({ at, reason, hold }),
        )
    } catch {
        // storage unavailable — the in-memory latch still holds this tab
    }
}

/** An explicit sign-out: the login page's automatic sign-in stays off, in
 *  every tab, until someone signs in on purpose. */
export function markSignedOutByChoice(): void {
    try {
        window.localStorage.setItem(SIGNED_OUT_MARKER, String(Date.now()))
    } catch {
        // storage unavailable — the tab's own sentinel still holds it
    }
}

/** A sign-in happened: automatic sign-in may run again next time. */
export function clearSignedOutByChoice(): void {
    try {
        window.localStorage.removeItem(SIGNED_OUT_MARKER)
    } catch {
        // best-effort
    }
}

function signedOutByChoice(): boolean {
    try {
        return window.localStorage.getItem(SIGNED_OUT_MARKER) !== null
    } catch {
        return false
    }
}

/** True while the login page's silent attempt should stay quiet: the
 *  person signed out on purpose, it ran recently, or a recovery just
 *  failed. The last two are time-based rather than forever — the old
 *  boolean sentinel meant the second expiry of the day landed every
 *  long-lived tab on the form for good. The first lasts until a sign-in:
 *  signing out is a statement of intent, and a password user who signs
 *  out is not signed back in by opening a new tab either. */
export function autoPortalAlreadyTried(): boolean {
    if (signedOutByChoice()) return true
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

/** A fresh session exists: clear what the failures latched, and let the
 *  caches catch up WITHOUT waiting for them. This runs inside the refresh
 *  machinery's lock, and the hydrate's own requests can need that
 *  machinery — a 401 or a CSRF repair joins the in-flight refresh, which
 *  is waiting on this. Awaited here, that is a cycle nothing resolves. */
function recovered(user: AuthUser | undefined): void {
    clearReauthFailure()
    clearAutoPortalSentinel()
    void hydrateAfterRecovery(user)
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
 * in cooldown) and did not produce a session; the caller takes the user
 * to the sign-in page, which explains. `'not-applicable'` — this provider has no
 * browser half to run and its cookie could not be redeemed in place, or
 * it could not be resolved; the caller keeps its existing navigation
 * behaviour. `'gone'` — the catalog answered and
 * this slug is not in it (the connection was disabled or deleted, or
 * the master switch is off); the caller must land on the login PAGE,
 * because the provider's own login URL is now a dead route.
 */
export async function attemptSilentReauth(
    providerSlug: string | undefined,
): Promise<SilentReauthResult> {
    if (!providerSlug || typeof window === 'undefined') return 'not-applicable'
    if (readReauthFailure() !== null) return 'failed'

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), REAUTH_DEADLINE_MS)
    })
    try {
        const result = await Promise.race([
            runSilentReauth(providerSlug), deadline,
        ])
        if (result !== 'deadline') return result
        // The caller loads the sign-in page next, which abandons whatever
        // is still in flight and runs its own automatic attempt.
        markReauthFailure(
            'The sign-in service did not answer in time.', { hold: false },
        )
        return 'failed'
    } finally {
        clearTimeout(timer)
    }
}

async function runSilentReauth(
    providerSlug: string,
): Promise<SilentReauthResult> {
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
    if (!isGatewayProvider(provider)) {
        // No browser half is published — a plain ambient row, whose
        // corporate cookie rides every request to us. The empty-body
        // POST redeems it exactly as the server-leg navigation would,
        // but answers JSON, so a live corporate session renews without
        // the page going anywhere.
        try {
            const { user } = await loginWithBackchannel(provider.slug, {}, {
                skipAuthRefresh: true,
            })
            recovered(user)
            return 'recovered'
        } catch (err) {
            // The server's own refusal — no corporate cookie, the gateway
            // saying no — is the answer the navigation would get too, one
            // exchange later and without the page to come back to. Say it
            // on the sign-in page instead. A row that reads no cookie
            // refuses the shape itself (a bare 404), and a failure that
            // was only load or the network says nothing: both keep the
            // navigation.
            if (
                err instanceof BackchannelLoginError
                && !err.code.startsWith('http_')
                && !isTransientFailure(err)
            ) {
                markReauthFailure(err.message)
                return 'failed'
            }
            return 'not-applicable'
        }
    }

    let lastError: unknown
    let transient = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
            await new Promise<void>((resolve) => setTimeout(
                resolve, TRANSIENT_RETRY_MS + Math.floor(Math.random() * 1_000),
            ))
        }
        // The same composition the sign-in page runs — trigger, then
        // exchange or handle — so recovery cannot drift from sign-in. A
        // retry re-runs ALL of it: a browser-exchange assertion is
        // single-use, so re-posting the one that just failed would be
        // refused as a replay even when the failure was ours.
        let body: Awaited<ReturnType<typeof gatewaySignInBody>>
        try {
            body = await gatewaySignInBody(provider)
        } catch (err) {
            // The browser's own call to the corporate host — see
            // ``isTransientFailure`` for which of its failures are worth
            // the second attempt.
            lastError = err
            transient = isTransientFailure(err)
            if (!transient) break
            continue
        }
        try {
            const { user } = await loginWithBackchannel(provider.slug, body, {
                skipAuthRefresh: true,
            })
            recovered(user)
            return 'recovered'
        } catch (err) {
            lastError = err
            transient = isTransientFailure(err)
            if (!transient) break
        }
    }
    if (transient) {
        // Twice without an answer — rate-limited, a 5xx, the network, a
        // gateway that timed out. Nothing was learned about the corporate
        // session, so the cooldown is NOT latched: the login page this
        // lands on gets its own automatic attempt, bounded by its own
        // sentinel. Latching would make a 9am rush behind one corporate
        // egress address cost everyone a click and a minute. The reason is
        // still recorded, without the hold, so that page can say why the
        // person is looking at it.
        markReauthFailure(
            lastError instanceof GatewayCallError
                ? lastError.message
                : 'The sign-in service could not be reached.',
            { hold: false },
        )
        return 'failed'
    }
    markReauthFailure(
        lastError instanceof Error ? lastError.message : 'The sign-in did not work.',
    )
    return 'failed'
}

/**
 * Did the attempt fail without saying anything about the corporate session?
 *
 * On OUR half: the POST answering 429 or 5xx (``http_<status>`` — the body
 * was not our structured refusal), the gateway timing out behind it
 * (``backchannel_unavailable``), or the POST never getting an answer. On
 * the browser's own call to the corporate host: a timeout, a 429 or 5xx,
 * or no answer at all — a VPN still connecting, a Wi-Fi hop. A refusal —
 * no corporate session, the gateway saying no, an account-linking rule, a
 * 4xx from the corporate host, this page's security policy blocking the
 * call — is a verdict. A CORS rule fails exactly like the network does,
 * so it costs the one retry before it latches.
 */
function isTransientFailure(err: unknown): boolean {
    if (err instanceof GatewayCallError) return err.transient
    if (err instanceof BackchannelLoginError) {
        return /^http_(429|5\d\d)$/.test(err.code)
            || err.code === 'backchannel_unavailable'
    }
    return err instanceof TypeError
        && /failed to fetch|networkerror|load failed|timed out/i.test(err.message)
}
