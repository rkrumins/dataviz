/**
 * fetchWithTimeout — skipAuthRefresh guard.
 *
 * A 401 normally triggers one silent token refresh + retry. The post-refresh
 * permissions re-hydrate passes skipAuthRefresh so its own 401 can't re-enter
 * that path — the recursion that caused the app-wide request storm. This
 * proves the guard: with the flag, a 401 makes NO /auth/refresh attempt.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fetchWithTimeout } from './fetchWithTimeout'

const REFRESH_URL = '/api/v1/auth/refresh'
const realFetch = globalThis.fetch

function mock401() {
    // Every request 401s; a real Response so tryRefresh's clone().json() works.
    return vi.fn(async () => new Response('{}', { status: 401 }))
}

describe('fetchWithTimeout skipAuthRefresh', () => {
    afterEach(() => { globalThis.fetch = realFetch })

    it('attempts a token refresh on a normal 401', async () => {
        const f = mock401()
        globalThis.fetch = f as unknown as typeof fetch
        await fetchWithTimeout('/api/v1/me/permissions')
        const urls = f.mock.calls.map((c) => String(c[0]))
        expect(urls).toContain(REFRESH_URL)
    })

    it('does NOT attempt a refresh when skipAuthRefresh is set', async () => {
        const f = mock401()
        globalThis.fetch = f as unknown as typeof fetch
        await fetchWithTimeout('/api/v1/me/permissions', { skipAuthRefresh: true })
        const urls = f.mock.calls.map((c) => String(c[0]))
        expect(urls).not.toContain(REFRESH_URL)
        // Only the original request fired.
        expect(urls).toEqual(['/api/v1/me/permissions'])
    })
})
