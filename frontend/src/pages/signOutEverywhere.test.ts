/**
 * "Sign out everywhere" has to sign this tab out too.
 *
 * The button called the API and navigated to /login, and did nothing
 * else. The store was still `authenticated` and the cached user was
 * still in localStorage, so the login page took one look and rendered
 * "You're already signed in as System Administrator" — offering Continue
 * and "Sign in as someone else" — for the session the user had just
 * destroyed. Reloading re-read the same cache and said it again. There
 * was no way out of your own sign-out.
 *
 * The teardown already existed on `logout()`: clear the cache, reset the
 * store, broadcast to sibling tabs. The revoke-all path simply never
 * used it.
 *
 * These drive the store rather than the page, because the defect is in
 * what the handler does to shared state, not in how the card renders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/store/auth'
import { readUserCache, writeUserCache } from '@/store/userCache'

// Every field ``userCache`` validates — a partial object is rejected on
// read, which would make the cache assertion below pass for the wrong
// reason.
const USER = {
    id: 'usr_admin',
    email: 'admin@example.com',
    firstName: 'System',
    lastName: 'Administrator',
    role: 'super_admin',
    status: 'active',
    authProvider: 'local',
} as never

beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()  // where userCache lives
})

/** The state the page is in when the button is pressed. */
function signedIn(): void {
    writeUserCache(USER)
    useAuthStore.setState({
        status: 'authenticated',
        isAuthenticated: true,
        user: USER,
    })
}

describe('signing out everywhere', () => {
    it('leaves the store unauthenticated', async () => {
        // The condition the login page reads (`isAuthenticated && user`)
        // to decide whether to offer "You're already signed in as …".
        signedIn()
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

        await useAuthStore.getState().logout()

        expect(useAuthStore.getState().isAuthenticated).toBe(false)
        expect(useAuthStore.getState().user).toBeNull()
    })

    it('clears the cached user so a reload does not resurrect the banner', async () => {
        // Bootstrap reads this cache and optimistically authenticates
        // from it, which is why refreshing the page showed the same
        // message again rather than the login form.
        signedIn()
        expect(readUserCache()).not.toBeNull()
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

        await useAuthStore.getState().logout()

        expect(readUserCache()).toBeNull()
    })

    it('still tears down when the server call fails', async () => {
        // A user who pressed sign-out must end up signed out locally
        // whatever the network did — the alternative is a tab that
        // believes in a session it has just asked to destroy.
        signedIn()
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('network down')
        }))

        await useAuthStore.getState().logout()

        expect(useAuthStore.getState().isAuthenticated).toBe(false)
        expect(readUserCache()).toBeNull()
    })
})
