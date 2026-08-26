/**
 * The browser half of a back-channel sign-in.
 *
 * This half cannot move to the server, and that is the whole reason it
 * exists. Where the enterprise uses Kerberos the provider answers
 * `401 WWW-Authenticate: Negotiate`, and answering it needs a Service
 * Ticket from the workstation's OS credential store — reachable through
 * SSPI or GSS-API, by this browser, on this machine. Our backend holds
 * no ticket for the user. `credentials: 'include'` is what lets the
 * browser do it; without that flag the OS is never consulted and the
 * call simply fails, so it is pinned here.
 *
 * The rest is about not stranding people: a machine outside the domain,
 * or one whose browser has not been told to answer Negotiate for that
 * host, must land on a working form with a reason — never in a loop, and
 * never mid-navigation to a sign-in that was never going to work.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    BackchannelLoginError,
    leavesForIdp,
    loginWithBackchannel,
    needsAuthenticateFirst,
    runAuthenticateTrigger,
    type SsoProviderSummary,
} from '@/services/authService'

function provider(over: Partial<SsoProviderSummary> = {}): SsoProviderSummary {
    return {
        id: 'idp_1', slug: 'corp-gateway', displayName: 'Corporate Gateway',
        kind: 'backchannel', priority: 100,
        config: {
            authenticateUrl: 'https://sso.corporate.com/authenticate',
            authenticateMethod: 'POST',
            authenticateHeaders: { 'X-App-ID': 'app-1' },
        },
        ...over,
    } as SsoProviderSummary
}

const realFetch = global.fetch

afterEach(() => {
    global.fetch = realFetch
    vi.restoreAllMocks()
})

// ── which providers need which treatment ─────────────────────────────

describe('predicates', () => {
    it('needs the trigger only when one is configured', () => {
        expect(needsAuthenticateFirst(provider())).toBe(true)
        expect(needsAuthenticateFirst(provider({ config: {} }))).toBe(false)
        expect(needsAuthenticateFirst(provider({ config: undefined }))).toBe(false)
    })

    it('only OIDC and SAML actually leave this origin', () => {
        // The button's glyph follows this. A back-channel provider
        // resolves server-side and a cookie-sourced portal is read on the
        // request — both land the user straight back, so promising a
        // hand-off was false.
        expect(leavesForIdp(provider({ kind: 'oidc' }))).toBe(true)
        expect(leavesForIdp(provider({ kind: 'saml2' }))).toBe(true)
        expect(leavesForIdp(provider({ kind: 'backchannel' }))).toBe(false)
        expect(leavesForIdp(provider({ kind: 'custom_profile' }))).toBe(false)
    })
})

// ── the call itself ──────────────────────────────────────────────────

describe('the authenticate call', () => {
    it('includes credentials, which is what lets the OS answer', async () => {
        // Without this the browser never consults SSPI/GSS-API, the
        // Negotiate challenge goes unanswered, and the call fails with
        // nothing to indicate why.
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(null, { status: 204 }),
        )
        global.fetch = fetchMock

        await runAuthenticateTrigger(provider())

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://sso.corporate.com/authenticate')
        expect(init.credentials).toBe('include')
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({ 'X-App-ID': 'app-1' })
    })

    it('returns null when the provider works by setting a cookie', async () => {
        // Not a failure — the cookie is on a domain our backend shares,
        // so the next navigation carries it.
        global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
        expect(await runAuthenticateTrigger(provider())).toBeNull()
    })

    it('returns the handle when the provider answers with one', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ token: 'handle-abc' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        )
        const got = await runAuthenticateTrigger(provider({
            config: { ...provider().config, authenticateTokenPath: 'token' },
        }))
        expect(got).toBe('handle-abc')
    })

    it('walks a nested path, the same syntax the server uses', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ data: { tokens: [{ value: 'deep' }] } }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        )
        const got = await runAuthenticateTrigger(provider({
            config: {
                ...provider().config,
                authenticateTokenPath: 'data.tokens[0].value',
            },
        }))
        expect(got).toBe('deep')
    })

    it('throws on a refusal rather than pretending it worked', async () => {
        // A 401 that survives to here means the Negotiate challenge went
        // unanswered — the machine is off-domain, or the browser has not
        // been told to answer for this host.
        global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
        await expect(runAuthenticateTrigger(provider())).rejects.toThrow(/401/)
    })

    it('throws when the promised value is not there', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ nope: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        )
        await expect(runAuthenticateTrigger(provider({
            config: { ...provider().config, authenticateTokenPath: 'token' },
        }))).rejects.toThrow(/token/)
    })

    it('gives up on an endpoint that never answers', async () => {
        // The raw fetch here has no wrapper-supplied timeout, so it
        // brings its own. Without one, a hung corporate endpoint left
        // the silent sign-in spinning forever with no error and no form.
        vi.useFakeTimers()
        try {
            global.fetch = vi.fn().mockImplementation(
                (_url, init: RequestInit) => new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')))
                }),
            )
            const attempt = runAuthenticateTrigger(provider())
            const outcome = expect(attempt).rejects.toThrow(/did not answer/)
            await vi.advanceTimersByTimeAsync(10_000)
            await outcome
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not inspect the handle it returns', async () => {
        // It is opaque. The server redeems it against the provider's own
        // gateway, which is the only party that can say what it means —
        // so a value that looks like nothing in particular is fine.
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ token: '····not-a-jwt····' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }),
        )
        expect(await runAuthenticateTrigger(provider({
            config: { ...provider().config, authenticateTokenPath: 'token' },
        }))).toBe('····not-a-jwt····')
    })
})

// ── the refusal, typed ───────────────────────────────────────────────

describe('a refused backchannel sign-in', () => {
    it('carries the code, email and reasons off the 401 detail', async () => {
        // The bare Error this used to throw discarded the server's
        // structured refusal, so the page could only shrug at a
        // collision it had everything needed to explain.
        global.fetch = vi.fn().mockResolvedValue(new Response(
            JSON.stringify({
                detail: {
                    error: 'unsafe_auto_link', email: 'ada@corp.example',
                    reasons: ['policy:manual_only'],
                },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        ))

        const err = await loginWithBackchannel(
            'corp-gateway', {}, { skipAuthRefresh: true },
        ).then(() => null, (e: unknown) => e)

        expect(err).toBeInstanceOf(BackchannelLoginError)
        const typed = err as BackchannelLoginError
        expect(typed.code).toBe('unsafe_auto_link')
        expect(typed.email).toBe('ada@corp.example')
        expect(typed.reasons).toEqual(['policy:manual_only'])
        // Generic message for surfaces that only render text.
        expect(typed.message).toMatch(/did not work/i)
    })

    it('degrades to the status code when the body is not the envelope', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response('bad gateway', { status: 502 }),
        )

        const err = await loginWithBackchannel(
            'corp-gateway', {}, { skipAuthRefresh: true },
        ).then(() => null, (e: unknown) => e)

        expect(err).toBeInstanceOf(BackchannelLoginError)
        expect((err as BackchannelLoginError).code).toBe('http_502')
        expect((err as BackchannelLoginError).email).toBeUndefined()
    })
})

describe('the translate call with a nested JSON reply', () => {
    it('hands an object at the token path over as JSON', async () => {
        // A bare-JSON gateway can nest the claims object itself at the
        // path. The assertion POST carries a string; the trust-unsigned
        // posture reads it, and a verifying row refuses it server-side.
        const { runBrowserExchangeCall } = await import('@/services/authService')
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({
                data: { sub: 'emp-1', email: 'ada@corp.example' },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        )

        const token = await runBrowserExchangeCall({
            url: 'https://sso.corporate.com/translate', tokenPath: 'data',
        })
        expect(JSON.parse(token)).toEqual({
            sub: 'emp-1', email: 'ada@corp.example',
        })
    })
})

describe('the translate call forwarding the trigger token', () => {
    // Some gateways require the token the authenticate call answered
    // with in the translate request's body — without it they refuse
    // with "no request body is set". The row names the JSON field; the
    // trigger's answer is the value.
    const jwt = 'eyJ.header.payload'

    async function call(over: Record<string, unknown> = {}) {
        const { runBrowserExchangeCall } = await import('@/services/authService')
        return runBrowserExchangeCall({
            url: 'https://sso.corporate.com/translate',
            method: 'POST',
            bodyField: 'token',
            token: 'corp-handle',
            ...over,
        })
    }

    it('POSTs the token back as JSON under the named field', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(jwt, { status: 200 }),
        )
        global.fetch = fetchMock

        expect(await call()).toBe(jwt)
        const [, init] = fetchMock.mock.calls[0]
        expect(init.body).toBe(JSON.stringify({ token: 'corp-handle' }))
        expect(new Headers(init.headers).get('content-type'))
            .toBe('application/json')
        expect(init.credentials).toBe('include')
    })

    it('never overrides an operator’s explicit Content-Type', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(jwt, { status: 200 }),
        )
        global.fetch = fetchMock

        await call({ headers: { 'Content-Type': 'application/xyz' } })
        expect(new Headers(fetchMock.mock.calls[0][1].headers)
            .get('content-type')).toBe('application/xyz')
    })

    it('sends no body at all when no field is named', async () => {
        // The original cookie-only shape must stay byte-identical.
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(jwt, { status: 200 }),
        )
        global.fetch = fetchMock

        await call({ bodyField: undefined, token: undefined })
        expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
    })

    it('refuses before calling out when the trigger produced no token', async () => {
        // A switched-off or cookie-only trigger leaves nothing to
        // forward; the gateway would answer with an opaque refusal, so
        // the mismatch is named here instead.
        const fetchMock = vi.fn()
        global.fetch = fetchMock

        await expect(call({ token: null })).rejects.toThrow(
            /no token was produced/,
        )
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
