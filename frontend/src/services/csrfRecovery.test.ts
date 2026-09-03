/**
 * A missing CSRF cookie must repair itself, not strand the session.
 *
 * `nx_csrf` can go missing while the session is perfectly valid. The
 * concrete case: `clear_session_cookies` evicts across every domain scope
 * a cookie might hold — deliberately including the parent that two
 * sibling deployments share — so signing out of one instance deletes the
 * other's CSRF cookie. The access and refresh cookies are name-scoped and
 * survive; the tab stays authenticated and simply cannot write any more.
 *
 * Nothing used to re-mint it without a full page reload, whose `/auth/me`
 * heals the cookie as a side effect. The repair is now that same heal on
 * its own route — `GET /auth/csrf` re-mints `nx_csrf` against the live
 * session WITHOUT rotating it: no session ceilings, no per-session rate
 * limit, no session-lost latch, none of the ways a rotation-based repair
 * could fail and leave the 403 stranded until the user refreshed the page.
 * A rotation is the fallback, only when there is no live session to heal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    ensureCsrfToken,
    fetchWithTimeout,
    setAuthEnvironmentId,
} from './fetchWithTimeout'

const CSRF_403 = {
    detail: { error: 'csrf_failed', cookie_present: false, message: 'CSRF token missing or invalid' },
}

function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

function setCookie(name: string, value: string): void {
    document.cookie = `${name}=${value}`
}

function clearCookies(): void {
    for (const name of ['nx_csrf', 'nx_csrf_a', 'nx_access_exp', 'nx_access_exp_a']) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`
    }
}

beforeEach(() => {
    clearCookies()
    setAuthEnvironmentId(null)
    vi.restoreAllMocks()
})

describe('CSRF failure recovery', () => {
    it('heals once and retries the write', async () => {
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                calls.push(url)
                if (url.includes('/auth/csrf')) {
                    // The heal is what re-mints the cookie — in place, no
                    // rotation.
                    setCookie('nx_csrf', 'fresh-token')
                    return json({ ok: true }, 200)
                }
                // First write fails CSRF; after the heal it succeeds.
                return calls.filter((c) => c.includes('/views')).length === 1
                    ? json(CSRF_403, 403)
                    : json({ ok: true }, 200)
            }),
        )

        const res = await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(res.status).toBe(200)
        expect(calls.some((c) => c.includes('/auth/csrf'))).toBe(true)
        // Repaired without rotating the session.
        expect(calls.some((c) => c.includes('/auth/refresh'))).toBe(false)
    })

    it('rotates only when there is no live session to heal', async () => {
        // The heal reports no session (the access token lapsed too), so the
        // repair escalates to a rotation, which re-mints the cookie as a
        // side effect and lets the write replay.
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                calls.push(url)
                if (url.includes('/auth/csrf')) {
                    return json({ detail: 'Not authenticated' }, 401)
                }
                if (url.includes('/auth/refresh')) {
                    setCookie('nx_csrf', 'rotated-token')
                    return json({ user: {} }, 200)
                }
                return calls.filter((c) => c.includes('/views')).length === 1
                    ? json(CSRF_403, 403)
                    : json({ ok: true }, 200)
            }),
        )

        const res = await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(res.status).toBe(200)
        expect(calls.filter((c) => c.includes('/auth/csrf'))).toHaveLength(1)
        expect(calls.filter((c) => c.includes('/auth/refresh'))).toHaveLength(1)
    })

    it('does not announce a permission failure for a CSRF failure', async () => {
        // The user holds the permission. Rendering this in the
        // access-denied modal sends them to an administrator to fix
        // something that is not broken.
        const denied = vi.fn()
        window.addEventListener('auth:access-denied', denied)

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                // Neither repair leg restores the cookie here, so the write
                // stays 403 — and still must not reach the modal.
                if (url.includes('/auth/csrf')) return json({ detail: 'no' }, 401)
                if (url.includes('/auth/refresh')) return json({ detail: 'no' }, 401)
                return json(CSRF_403, 403)
            }),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })
        await new Promise((r) => setTimeout(r, 0))

        expect(denied).not.toHaveBeenCalled()
        window.removeEventListener('auth:access-denied', denied)
    })

    it('still announces a genuine permission denial', async () => {
        // The guard against over-correcting: a real 403 must keep
        // reaching the modal it was built for.
        const denied = vi.fn()
        window.addEventListener('auth:access-denied', denied)

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                json(
                    {
                        detail: {
                            error: 'missing_permission',
                            permission: 'workspace:view:delete',
                            scope: { type: 'workspace', id: 'ws_a' },
                            message: 'Missing permission: workspace:view:delete',
                        },
                    },
                    403,
                ),
            ),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })
        await vi.waitFor(() => expect(denied).toHaveBeenCalled())

        window.removeEventListener('auth:access-denied', denied)
    })

    it('sends the environment-scoped CSRF cookie when there is one', async () => {
        // Two deployments in one jar: the header has to echo THIS
        // deployment's cookie, or the backend's own comparison fails.
        setCookie('nx_csrf', 'sibling-value')
        setCookie('nx_csrf_a', 'mine')
        setAuthEnvironmentId('a')

        let sent: string | null = null
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                sent = new Headers(init?.headers).get('X-CSRF-Token')
                return json({ ok: true }, 200)
            }),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(sent).toBe('mine')
    })

    it('falls back to the unscoped cookie before bootstrap answers', async () => {
        // A backend too old to scope the name, or a write that somehow
        // beats /auth/me. Omitting the header entirely would 403 every
        // write — strictly worse than sending a shared value.
        setCookie('nx_csrf', 'legacy')

        let sent: string | null = null
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                sent = new Headers(init?.headers).get('X-CSRF-Token')
                return json({ ok: true }, 200)
            }),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(sent).toBe('legacy')
    })
})

describe('a session that has lost its CSRF cookie', () => {
    it('heals it before a write instead of sending a doomed one', async () => {
        // The reactive repair spends a guaranteed-403 round trip to
        // learn something readable from document.cookie.
        document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + 900}`
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                calls.push(String(input))
                if (String(input).includes('/auth/csrf')) {
                    setCookie('nx_csrf', 'reminted')
                    return json({ ok: true }, 200)
                }
                return json({ ok: true }, 200)
            }),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(calls[0]).toContain('/auth/csrf')
        expect(calls[1]).toContain('/views/v1')
        // One attempt at the write, not two — and no rotation.
        expect(calls.filter((c) => c.includes('/views/v1'))).toHaveLength(1)
        expect(calls.some((c) => c.includes('/auth/refresh'))).toBe(false)
    })

    it('does not heal for an anonymous write', async () => {
        // No session: nx_access_exp absent. Firing a heal before every
        // /auth/login POST would be pure noise.
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                calls.push(String(input))
                return json({ ok: true }, 200)
            }),
        )

        await fetchWithTimeout('/api/v1/auth/signup', { method: 'POST' })

        expect(calls.some((c) => c.includes('/auth/csrf'))).toBe(false)
        expect(calls.some((c) => c.includes('/auth/refresh'))).toBe(false)
    })

    it('leaves a session that still has its cookie alone', async () => {
        document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + 900}`
        setCookie('nx_csrf', 'intact')
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                calls.push(String(input))
                return json({ ok: true }, 200)
            }),
        )

        await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(calls).toHaveLength(1)
    })
})

describe('concurrent writes during a repair', () => {
    // The intermittent bug this section exists for: the repair used to
    // hold a boolean latch, and any write issued while it was set
    // SKIPPED the wait, went out with no header at all, and had its 403
    // retry suppressed by the same flag. Joining is the contract now.

    it('two concurrent writes share one heal and both carry the header', async () => {
        document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + 900}`
        const calls: string[] = []
        const headers: Array<string | null> = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input)
                calls.push(url)
                if (url.includes('/auth/csrf')) {
                    setCookie('nx_csrf', 'reminted')
                    return json({ ok: true }, 200)
                }
                headers.push(new Headers(init?.headers).get('X-CSRF-Token'))
                return json({ ok: true }, 200)
            }),
        )

        await Promise.all([
            fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' }),
            fetchWithTimeout('/api/v1/views/v2', { method: 'DELETE' }),
        ])

        expect(calls.filter((c) => c.includes('/auth/csrf'))).toHaveLength(1)
        expect(calls.filter((c) => c.includes('/views/'))).toHaveLength(2)
        expect(headers).toEqual(['reminted', 'reminted'])
    })

    it('a write issued during bootstrap joins the bootstrap repair', async () => {
        document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + 900}`
        const calls: string[] = []
        let sent: string | null = null
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input)
                calls.push(url)
                if (url.includes('/auth/csrf')) {
                    setCookie('nx_csrf', 'reminted')
                    return json({ ok: true }, 200)
                }
                sent = new Headers(init?.headers).get('X-CSRF-Token')
                return json({ ok: true }, 200)
            }),
        )

        // The store's bootstrap call, un-awaited — then a write lands.
        const bootstrap = ensureCsrfToken()
        const write = fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })
        await Promise.all([bootstrap, write])

        expect(calls.filter((c) => c.includes('/auth/csrf'))).toHaveLength(1)
        expect(calls[0]).toContain('/auth/csrf')
        expect(calls[calls.length - 1]).toContain('/views/v1')
        expect(sent).toBe('reminted')
    })

    it('a csrf 403 mid-repair joins it and still replays once', async () => {
        // The stale-cookie shape: the pre-flight sees a cookie and sends,
        // both writes 403, and both must come back exactly once with the
        // re-minted token — one shared heal, no suppressed retries.
        document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + 900}`
        setCookie('nx_csrf', 'stale')
        let releaseHeal!: () => void
        const healGate = new Promise<void>((r) => { releaseHeal = r })
        const attempts: Record<string, Array<string | null>> = {}
        let healCalls = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input)
                if (url.includes('/auth/csrf')) {
                    healCalls += 1
                    await healGate
                    setCookie('nx_csrf', 'fresh')
                    return json({ ok: true }, 200)
                }
                const seen = (attempts[url] ??= [])
                seen.push(new Headers(init?.headers).get('X-CSRF-Token'))
                return seen.length === 1
                    ? json(CSRF_403, 403)
                    : json({ ok: true }, 200)
            }),
        )

        const writes = Promise.all([
            fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' }),
            fetchWithTimeout('/api/v1/views/v2', { method: 'DELETE' }),
        ])
        // Let both first attempts 403 and both join the held repair.
        await new Promise((r) => setTimeout(r, 0))
        releaseHeal()
        const [r1, r2] = await writes

        expect(healCalls).toBe(1)
        expect(r1.status).toBe(200)
        expect(r2.status).toBe(200)
        for (const url of Object.keys(attempts)) {
            expect(attempts[url]).toEqual(['stale', 'fresh'])
        }
        expect(Object.keys(attempts)).toHaveLength(2)
    })
})
