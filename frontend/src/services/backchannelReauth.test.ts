/**
 * The silent-recovery state machine, edge by edge.
 *
 * The property the whole feature hangs on: every path terminates. A
 * recovery either produces a session (and the app never notices the
 * corporate one died), or it latches a failure and the user lands on a
 * form with a reason — never in a loop, and never hammering a corporate
 * IdP that is genuinely down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
    fetchWithTimeout, loginWithBackchannel, runAuthenticateTrigger,
    runBrowserExchange, refreshPermissions, notifyPermissionsChanged,
    writeUserCache,
} = vi.hoisted(() => ({
    fetchWithTimeout: vi.fn(),
    loginWithBackchannel: vi.fn(),
    runAuthenticateTrigger: vi.fn(),
    runBrowserExchange: vi.fn(),
    refreshPermissions: vi.fn(),
    notifyPermissionsChanged: vi.fn(),
    writeUserCache: vi.fn(),
}))

vi.mock('./fetchWithTimeout', () => ({ fetchWithTimeout }))
vi.mock('./authService', async () => {
    const actual = await vi.importActual<typeof import('./authService')>(
        './authService',
    )
    return {
        ...actual,
        loginWithBackchannel,
        runAuthenticateTrigger,
        runBrowserExchange,
    }
})
vi.mock('@/store/auth', () => ({
    useAuthStore: { getState: () => ({ refreshPermissions }) },
}))
vi.mock('@/store/userCache', () => ({ writeUserCache }))
vi.mock('@/store/permissionChangeBus', () => ({ notifyPermissionsChanged }))

import {
    attemptSilentReauth,
    autoPortalAlreadyTried,
    clearReauthFailure,
    clearSignedOutByChoice,
    markAutoPortalTried,
    markSignedOutByChoice,
    readReauthFailure,
    REAUTH_COOLDOWN_MS,
} from './backchannelReauth'
import { BackchannelLoginError, GatewayCallError } from './authService'

const GATEWAY = {
    id: 'idp_1', slug: 'corp-gateway', displayName: 'Corporate Gateway',
    kind: 'backchannel', priority: 100,
    config: {
        authenticateUrl: 'https://sso.corporate.com/authenticate',
    },
}

function contextWith(providers: unknown[]) {
    // A fresh Response per call — a body reads once, and the retry
    // tests resolve the catalog more than once.
    fetchWithTimeout.mockImplementation(async () => new Response(
        JSON.stringify({
            allowLocalLogin: true, emailFirstLogin: false, providers,
        }),
        { status: 200 },
    ))
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    window.localStorage.clear()
    clearReauthFailure()
    contextWith([GATEWAY])
    runAuthenticateTrigger.mockResolvedValue(null)
    runBrowserExchange.mockResolvedValue('assertion-jwt')
    loginWithBackchannel.mockResolvedValue({ user: { id: 'u1' } })
    refreshPermissions.mockResolvedValue(undefined)
    notifyPermissionsChanged.mockResolvedValue(undefined)
})

afterEach(() => { vi.restoreAllMocks() })

describe('recovery', () => {
    it('re-runs the trigger and completes the cookie shape in place', async () => {
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(loginWithBackchannel).toHaveBeenCalledWith(
            'corp-gateway', {}, { skipAuthRefresh: true },
        )
    })

    it('posts the handle when the trigger answers with one', async () => {
        runAuthenticateTrigger.mockResolvedValue('handle-abc')
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(loginWithBackchannel).toHaveBeenCalledWith(
            'corp-gateway', { handle: 'handle-abc' }, { skipAuthRefresh: true },
        )
    })

    it('re-runs the whole browser exchange for a browser-mode row', async () => {
        contextWith([{
            ...GATEWAY,
            config: {
                ...GATEWAY.config,
                browserExchangeUrl: 'https://sso.corporate.com/translate',
            },
        }])
        // The trigger's answer rides into the exchange, so a row that
        // forwards it in the translate body recovers silently too.
        runAuthenticateTrigger.mockResolvedValue('corp-handle')
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(runBrowserExchange).toHaveBeenCalledWith(
            expect.objectContaining({ slug: 'corp-gateway' }), 'corp-handle',
        )
        expect(loginWithBackchannel).toHaveBeenCalledWith(
            'corp-gateway', { assertion: 'assertion-jwt' },
            { skipAuthRefresh: true },
        )
    })

    it('hydrates what the app caches, so nothing runs on stale state', async () => {
        await attemptSilentReauth('corp-gateway')
        await vi.waitFor(() => {
            expect(writeUserCache).toHaveBeenCalledWith({ id: 'u1' })
            expect(refreshPermissions).toHaveBeenCalledWith({ skipAuthRefresh: true })
            expect(notifyPermissionsChanged).toHaveBeenCalled()
        })
    })

    it('does not wait for that hydrate to report the recovery', async () => {
        // It runs inside the refresh lock, and the hydrate's own requests
        // can need the refresh — which is waiting on this. Awaited, a
        // hydrate that joins the in-flight refresh never settles.
        refreshPermissions.mockReturnValue(new Promise(() => {}))
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
    })

    it('clears the login page sentinel, so a later bounce can auto-try', async () => {
        markAutoPortalTried()
        expect(autoPortalAlreadyTried()).toBe(true)
        await attemptSilentReauth('corp-gateway')
        expect(autoPortalAlreadyTried()).toBe(false)
    })
})

describe('standing aside', () => {
    it('no slug at all is not-applicable', async () => {
        expect(await attemptSilentReauth(undefined)).toBe('not-applicable')
        expect(loginWithBackchannel).not.toHaveBeenCalled()
    })

    it('an OIDC provider keeps its navigation', async () => {
        contextWith([{ ...GATEWAY, kind: 'oidc' }])
        expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
    })

    it('a row with no browser half renews in place from its cookie', async () => {
        // Server mode: the corporate cookie rides the POST itself, so the
        // empty body redeems it without the page going anywhere.
        contextWith([{ ...GATEWAY, config: {} }])
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(runAuthenticateTrigger).not.toHaveBeenCalled()
        expect(loginWithBackchannel).toHaveBeenCalledWith(
            'corp-gateway', {}, { skipAuthRefresh: true },
        )
    })

    it('a row with no browser half that is refused says so on the sign-in page', async () => {
        // The navigation would run the same exchange and get the same
        // answer, one round trip later and without the page to return to.
        contextWith([{ ...GATEWAY, config: {} }])
        loginWithBackchannel.mockRejectedValue(
            new BackchannelLoginError('backchannel_no_session'),
        )
        expect(await attemptSilentReauth('corp-gateway')).toBe('failed')
        expect(readReauthFailure()).not.toBeNull()
    })

    it('a row with no browser half keeps its navigation when the POST says nothing', async () => {
        // A row that reads no cookie refuses the shape (a bare 404); load
        // or the network is not an answer. The navigation still has a
        // chance in both, so neither latches.
        contextWith([{ ...GATEWAY, config: {} }])
        for (const code of ['http_404', 'http_503', 'backchannel_unavailable']) {
            loginWithBackchannel.mockRejectedValueOnce(new BackchannelLoginError(code))
            expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
            expect(readReauthFailure()).toBeNull()
        }
    })

    it('an unreachable catalog is not a verdict about the session', async () => {
        fetchWithTimeout.mockRejectedValue(new Error('offline'))
        expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
    })
})

describe('a connection that no longer exists', () => {
    // Disabled, deleted, or the master switch turned off: the catalog
    // answers and the slug is not in it. Navigating to the provider's
    // own login URL — the old fallback — lands on a raw 404, so this is
    // a terminal verdict of its own, not a case of "stand aside".

    it('is gone, with the reason latched for the login page', async () => {
        contextWith([])
        expect(await attemptSilentReauth('corp-gateway')).toBe('gone')
        expect(readReauthFailure()?.reason).toMatch(/no longer available/i)
        expect(loginWithBackchannel).not.toHaveBeenCalled()
    })

    it('is told apart from a catalog that merely lists others', async () => {
        contextWith([{ ...GATEWAY, slug: 'somebody-else' }])
        expect(await attemptSilentReauth('corp-gateway')).toBe('gone')
    })

    it('does not re-ask the catalog while the latch is fresh', async () => {
        contextWith([])
        await attemptSilentReauth('corp-gateway')
        fetchWithTimeout.mockClear()

        expect(await attemptSilentReauth('corp-gateway')).toBe('failed')
        expect(fetchWithTimeout).not.toHaveBeenCalled()
    })
})

describe('failure, latched', () => {
    it('a failed trigger latches with its reason', async () => {
        runAuthenticateTrigger.mockRejectedValue(
            new Error('The sign-in service answered 401.'),
        )
        expect(await attemptSilentReauth('corp-gateway')).toBe('failed')
        expect(readReauthFailure()?.reason).toMatch(/401/)
    })

    it('the cooldown short-circuits — a down IdP is not hammered', async () => {
        runAuthenticateTrigger.mockRejectedValue(new Error('down'))
        await attemptSilentReauth('corp-gateway')
        fetchWithTimeout.mockClear()

        expect(await attemptSilentReauth('corp-gateway')).toBe('failed')
        expect(fetchWithTimeout).not.toHaveBeenCalled()
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
    })

    it('the latch lapses on its own — recovery is suppressed, not disabled', async () => {
        const now = Date.now()
        window.sessionStorage.setItem('nx_bc_reauth_failed', JSON.stringify({
            at: now - REAUTH_COOLDOWN_MS - 1, reason: 'old news',
        }))
        expect(readReauthFailure()).toBeNull()
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
    })

    it('a refused sign-in latches too, and success clears it', async () => {
        loginWithBackchannel.mockRejectedValueOnce(
            new Error('Signing in with that session did not work.'),
        )
        expect(await attemptSilentReauth('corp-gateway')).toBe('failed')
        expect(readReauthFailure()).not.toBeNull()

        clearReauthFailure()
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(readReauthFailure()).toBeNull()
    })

    it('holds the login page sentinel while fresh', async () => {
        runAuthenticateTrigger.mockRejectedValue(new Error('down'))
        await attemptSilentReauth('corp-gateway')
        expect(autoPortalAlreadyTried()).toBe(true)
    })
})


describe('a busy moment is not a verdict', () => {
    // At 9am a whole office renews at once, often behind one corporate
    // egress address, and our own completion POST can answer 429 or 5xx.
    // That says nothing about the corporate session — treating it as a
    // refusal latched the cooldown and cost everyone a click and a minute.

    async function settle<T>(p: Promise<T>): Promise<T> {
        // The retry waits a jittered second; don't make the suite do so.
        await vi.runAllTimersAsync()
        return p
    }

    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('a rate-limited completion is retried once, from the top', async () => {
        loginWithBackchannel
            .mockRejectedValueOnce(new BackchannelLoginError('http_429'))
            .mockResolvedValueOnce({ user: { id: 'u1' } })

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('recovered')
        // The whole browser half again — a browser-exchange assertion is
        // single-use, so the one that just failed cannot be re-posted.
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(2)
        expect(loginWithBackchannel).toHaveBeenCalledTimes(2)
    })

    it('still failing, it leaves the cooldown unlatched for the login page', async () => {
        loginWithBackchannel.mockRejectedValue(new BackchannelLoginError('http_503'))

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('failed')
        expect(loginWithBackchannel).toHaveBeenCalledTimes(2)
        // The login page this lands on gets its own automatic attempt.
        expect(readReauthFailure()).toBeNull()
        expect(autoPortalAlreadyTried()).toBe(false)
    })

    it('a gateway that timed out behind us is retried too', async () => {
        loginWithBackchannel
            .mockRejectedValueOnce(new BackchannelLoginError('backchannel_unavailable'))
            .mockResolvedValueOnce({ user: { id: 'u1' } })

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('recovered')
    })

    it('a refusal is a verdict: no retry, and the cooldown latches', async () => {
        loginWithBackchannel.mockRejectedValue(
            new BackchannelLoginError('backchannel_no_session'),
        )

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('failed')
        expect(loginWithBackchannel).toHaveBeenCalledTimes(1)
        expect(readReauthFailure()).not.toBeNull()
    })

    it('the browser\'s own call failing like the network is retried once', async () => {
        // A VPN still connecting, a Wi-Fi hop: the corporate host never
        // answered, so nothing was learned about the corporate session.
        runAuthenticateTrigger
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(null)

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('recovered')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(2)
    })

    it('so is a corporate host that timed out or answered 5xx', async () => {
        runAuthenticateTrigger.mockRejectedValue(
            new GatewayCallError('The sign-in service answered 503.', true),
        )

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('failed')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(2)
        expect(readReauthFailure()).toBeNull()
    })

    it('a corporate host that answered is a verdict', async () => {
        // A 401 is the machine outside the domain, or no corporate
        // session at all — repeating it changes nothing.
        runAuthenticateTrigger.mockRejectedValue(
            new GatewayCallError('The sign-in service answered 401.', false),
        )

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('failed')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(readReauthFailure()?.reason).toMatch(/401/)
    })

    it('this page\'s security policy blocking the call is a verdict, with its fix', async () => {
        runAuthenticateTrigger.mockRejectedValue(new GatewayCallError(
            "Blocked by this site's security policy — add "
            + 'https://sso.corporate.com to CSP_CONNECT_SRC on the frontend.',
            false,
        ))

        expect(await settle(attemptSilentReauth('corp-gateway'))).toBe('failed')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(readReauthFailure()?.reason).toMatch(/CSP_CONNECT_SRC/)
    })
})

describe('signing out sticks', () => {
    it('holds the automatic sign-in in every tab until a sign-in', () => {
        markSignedOutByChoice()
        // Not the tab's sixty-second sentinel: localStorage, and no clock.
        window.sessionStorage.clear()
        expect(autoPortalAlreadyTried()).toBe(true)

        clearSignedOutByChoice()
        expect(autoPortalAlreadyTried()).toBe(false)
    })
})
