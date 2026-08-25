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
    markAutoPortalTried,
    readReauthFailure,
    REAUTH_COOLDOWN_MS,
} from './backchannelReauth'

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
        expect(await attemptSilentReauth('corp-gateway')).toBe('recovered')
        expect(runAuthenticateTrigger).toHaveBeenCalledTimes(1)
        expect(runBrowserExchange).toHaveBeenCalledTimes(1)
        expect(loginWithBackchannel).toHaveBeenCalledWith(
            'corp-gateway', { assertion: 'assertion-jwt' },
            { skipAuthRefresh: true },
        )
    })

    it('hydrates what the app caches, so nothing runs on stale state', async () => {
        await attemptSilentReauth('corp-gateway')
        expect(writeUserCache).toHaveBeenCalledWith({ id: 'u1' })
        expect(refreshPermissions).toHaveBeenCalledWith({ skipAuthRefresh: true })
        expect(notifyPermissionsChanged).toHaveBeenCalled()
    })

    it('clears the login page sentinel, so a later bounce can auto-try', async () => {
        markAutoPortalTried()
        expect(autoPortalAlreadyTried()).toBe(true)
        await attemptSilentReauth('corp-gateway')
        expect(autoPortalAlreadyTried()).toBe(false)
    })
})

describe('standing aside', () => {
    it.each([
        ['an unknown slug', 'nobody'],
        ['no slug at all', undefined],
    ])('%s is not-applicable', async (_name, slug) => {
        expect(await attemptSilentReauth(slug)).toBe('not-applicable')
        expect(loginWithBackchannel).not.toHaveBeenCalled()
    })

    it('an OIDC provider keeps its navigation', async () => {
        contextWith([{ ...GATEWAY, kind: 'oidc' }])
        expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
    })

    it('a row with no browser half keeps its navigation', async () => {
        // The corporate cookie may still be alive — the server leg the
        // navigation runs is the right tool, and nothing here beats it.
        contextWith([{ ...GATEWAY, config: {} }])
        expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
    })

    it('an unreachable catalog is not a verdict about the session', async () => {
        fetchWithTimeout.mockRejectedValue(new Error('offline'))
        expect(await attemptSilentReauth('corp-gateway')).toBe('not-applicable')
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
