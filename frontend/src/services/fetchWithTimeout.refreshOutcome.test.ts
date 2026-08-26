/**
 * A failed refresh is not one thing, and treating it as one logged
 * people out for no reason.
 *
 * ``tryRefresh`` used to return a boolean, so "your session is gone"
 * (a 401) and "the network hiccuped" (a 429 from the refresh endpoint's
 * own rate limiter, a 502, a dropped connection) both came back
 * ``false`` — and ``false`` dispatched ``auth:session-lost``. Users were
 * being signed out mid-session by a rate limiter.
 *
 * The rule these tests pin: ONLY a definitive 401 that is not the SSO
 * re-auth envelope may sign anybody out. Everything else is retried once
 * and then surfaced as the original 401, with the session left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, resetSessionLostLatch } from './fetchWithTimeout'

const { attemptSilentReauth } = vi.hoisted(() => ({
    attemptSilentReauth: vi.fn(),
}))
vi.mock('./backchannelReauth', () => ({ attemptSilentReauth }))

const REFRESH_URL = '/api/v1/auth/refresh'
const PROTECTED_URL = '/api/v1/workspaces'
const realFetch = globalThis.fetch
const realLocation = window.location

/** Responses the refresh endpoint gives back, in order; the last one
 *  repeats. Everything else 401s. */
function mockFetch(refreshResponses: Array<() => Promise<Response>>) {
    let n = 0
    return vi.fn(async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) === REFRESH_URL) {
            const make = refreshResponses[Math.min(n, refreshResponses.length - 1)]
            n += 1
            return make()
        }
        return new Response('{}', { status: 401 })
    })
}

const unauthorized = async () => new Response('{}', { status: 401 })
const rateLimited = (retryAfter?: string) => async () =>
    new Response('{}', {
        status: 429,
        headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    })
const serverError = async () => new Response('{}', { status: 502 })
const networkDown = async () => { throw new TypeError('Failed to fetch') }
const ssoReauth = async () =>
    new Response(
        JSON.stringify({
            detail: { error: 'sso_reauth_required', login_url: '/api/v1/auth/entra/login' },
        }),
        { status: 401 },
    )

function refreshCalls(f: ReturnType<typeof mockFetch>): number {
    return f.mock.calls.filter((c) => String(c[0]) === REFRESH_URL).length
}

let sessionLost: number
const countSessionLost = () => { sessionLost += 1 }

function setPath(pathname: string) {
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { pathname, href: `http://localhost${pathname}`, assign: vi.fn() },
    })
}

beforeEach(() => {
    sessionLost = 0
    window.addEventListener('auth:session-lost', countSessionLost)
    resetSessionLostLatch()
    setPath('/dashboard')
    attemptSilentReauth.mockReset()
    attemptSilentReauth.mockResolvedValue('not-applicable')
})

afterEach(() => {
    window.removeEventListener('auth:session-lost', countSessionLost)
    globalThis.fetch = realFetch
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})


describe('a definitive 401 from the refresh endpoint', () => {
    it('announces the lost session exactly once', async () => {
        const f = mockFetch([unauthorized])
        globalThis.fetch = f as unknown as typeof fetch

        const res = await fetchWithTimeout(PROTECTED_URL)

        expect(res.status).toBe(401)
        expect(refreshCalls(f)).toBe(1)
        expect(sessionLost).toBe(1)
    })

    it('makes one refresh call and one announcement for five staggered 401s', async () => {
        // Staggered, not concurrent — the shared in-flight promise does
        // nothing for these. Without the latch each one re-asked a
        // settled question and dispatched its own sign-out.
        const f = mockFetch([unauthorized])
        globalThis.fetch = f as unknown as typeof fetch

        for (let i = 0; i < 5; i += 1) {
            await fetchWithTimeout(PROTECTED_URL)
        }

        expect(refreshCalls(f)).toBe(1)
        expect(sessionLost).toBe(1)
    })
})


describe('an inconclusive refresh', () => {
    it('signs nobody out when the refresh endpoint is rate-limited', async () => {
        const f = mockFetch([rateLimited()])
        globalThis.fetch = f as unknown as typeof fetch

        const res = await fetchWithTimeout(PROTECTED_URL)

        expect(sessionLost).toBe(0)
        // The caller still sees the truth about ITS request.
        expect(res.status).toBe(401)
    })

    it('retries once, honouring Retry-After', async () => {
        const f = mockFetch([rateLimited('0')])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout(PROTECTED_URL)

        expect(refreshCalls(f)).toBe(2)
        expect(sessionLost).toBe(0)
    })

    it('signs nobody out when the refresh throws', async () => {
        const f = mockFetch([networkDown])
        globalThis.fetch = f as unknown as typeof fetch

        const res = await fetchWithTimeout(PROTECTED_URL)

        expect(sessionLost).toBe(0)
        expect(res.status).toBe(401)
    })

    it('signs nobody out on a 5xx', async () => {
        const f = mockFetch([serverError])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout(PROTECTED_URL)

        expect(sessionLost).toBe(0)
    })

    it('leaves the latch clear, so a later real 401 still lands', async () => {
        globalThis.fetch = mockFetch([rateLimited()]) as unknown as typeof fetch
        await fetchWithTimeout(PROTECTED_URL)
        expect(sessionLost).toBe(0)

        globalThis.fetch = mockFetch([unauthorized]) as unknown as typeof fetch
        await fetchWithTimeout(PROTECTED_URL)
        expect(sessionLost).toBe(1)
    })
})


describe('the SSO re-auth envelope', () => {
    it('navigates to the IdP instead of signing the user out', async () => {
        const f = mockFetch([ssoReauth])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout(PROTECTED_URL)

        expect(window.location.href).toBe('/api/v1/auth/entra/login')
        expect(sessionLost).toBe(0)
    })
})


describe('the silent back-channel recovery', () => {
    const gatewayReauth = async () =>
        new Response(
            JSON.stringify({
                detail: {
                    error: 'sso_reauth_required',
                    provider: 'corp-gateway',
                    login_url: '/api/v1/auth/corp-gateway/login?next=%2F&force=1',
                },
            }),
            { status: 401 },
        )

    it('reads a recovery as a successful refresh — no navigation, request retried', async () => {
        attemptSilentReauth.mockResolvedValue('recovered')
        let protectedCalls = 0
        globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
            if (String(args[0]) === REFRESH_URL) return gatewayReauth()
            protectedCalls += 1
            // 401 before the recovery, 200 after — the retried request
            // rides the re-established cookies.
            return protectedCalls === 1
                ? new Response('{}', { status: 401 })
                : new Response('{}', { status: 200 })
        }) as unknown as typeof fetch

        const res = await fetchWithTimeout(PROTECTED_URL)

        expect(attemptSilentReauth).toHaveBeenCalledWith('corp-gateway')
        expect(res.status).toBe(200)
        expect(window.location.href).toBe('http://localhost/dashboard')
        expect(sessionLost).toBe(0)
    })

    it('reads a failed recovery as a lost session — one announcement, no navigation', async () => {
        attemptSilentReauth.mockResolvedValue('failed')
        const f = mockFetch([gatewayReauth])
        globalThis.fetch = f as unknown as typeof fetch

        const res = await fetchWithTimeout(PROTECTED_URL)

        expect(res.status).toBe(401)
        expect(sessionLost).toBe(1)
        expect(window.location.href).toBe('http://localhost/dashboard')
    })

    it('keeps the navigation for a provider it cannot recover', async () => {
        attemptSilentReauth.mockResolvedValue('not-applicable')
        const f = mockFetch([gatewayReauth])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout(PROTECTED_URL)

        expect(window.location.href)
            .toBe('/api/v1/auth/corp-gateway/login?next=%2F&force=1')
        expect(sessionLost).toBe(0)
    })

    it('lands a vanished provider on the login page, never its dead URL', async () => {
        // The provider was disabled or deleted mid-session. Its
        // login_url now answers raw 404 JSON — the one place the user
        // must not end up. The login page reads the latched reason.
        attemptSilentReauth.mockResolvedValue('gone')
        const f = mockFetch([gatewayReauth])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout(PROTECTED_URL)

        expect(window.location.href).toBe('/login')
        expect(sessionLost).toBe(0)
    })
})


describe('the login route', () => {
    it('does not silently recover a session', async () => {
        // Landing on /login must show the form. Recovering here signed
        // people in without a keystroke and made switching accounts
        // impossible.
        setPath('/login')
        const f = mockFetch([unauthorized])
        globalThis.fetch = f as unknown as typeof fetch

        const res = await fetchWithTimeout('/api/v1/auth/me')

        expect(refreshCalls(f)).toBe(0)
        expect(sessionLost).toBe(0)
        expect(res.status).toBe(401)
    })

    it('still recovers silently on an app route', async () => {
        // The exemption is scoped to the login PAGE, not to reloads:
        // /dashboard with an expired access cookie must not log anyone out.
        setPath('/dashboard')
        const f = mockFetch([unauthorized])
        globalThis.fetch = f as unknown as typeof fetch

        await fetchWithTimeout('/api/v1/auth/me')

        expect(refreshCalls(f)).toBe(1)
    })
})
