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
 * Nothing used to re-mint it. A 403 does not trigger the refresh path the
 * way a 401 does, so every write failed indefinitely, reported through
 * the access-denied modal as a permission the user demonstrably held. The
 * repair is one rotation: `/auth/refresh` sets all four cookies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchWithTimeout, setAuthEnvironmentId } from './fetchWithTimeout'

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
    it('refreshes once and retries the write', async () => {
        const calls: string[] = []
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                calls.push(url)
                if (url.includes('/auth/refresh')) {
                    // The rotation is what re-mints the cookie.
                    setCookie('nx_csrf', 'fresh-token')
                    return json({ user: {} }, 200)
                }
                // First write fails CSRF; after the refresh it succeeds.
                return calls.filter((c) => c.includes('/views')).length === 1
                    ? json(CSRF_403, 403)
                    : json({ ok: true }, 200)
            }),
        )

        const res = await fetchWithTimeout('/api/v1/views/v1', { method: 'DELETE' })

        expect(res.status).toBe(200)
        expect(calls.some((c) => c.includes('/auth/refresh'))).toBe(true)
    })

    it('does not announce a permission failure for a CSRF failure', async () => {
        // The user holds the permission. Rendering this in the
        // access-denied modal sends them to an administrator to fix
        // something that is not broken.
        const denied = vi.fn()
        window.addEventListener('auth:access-denied', denied)

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) =>
                String(input).includes('/auth/refresh')
                    ? json({ detail: 'no' }, 401)
                    : json(CSRF_403, 403),
            ),
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
