/**
 * Tests for the sessionStorage-cache integration in ``useAuthStore``.
 *
 * The cache is a pure render-seed: bootstrap reads it synchronously,
 * but the cookie validation via ``/auth/me`` still drives the final
 * status. These tests cover the four state transitions that matter:
 *
 *   1. Warm cache + /me success         -> stays authenticated, cache refreshed
 *   2. Warm cache + /me 401             -> unauthenticated, cache wiped
 *   3. Cold cache + /me success         -> authenticated, cache populated
 *   4. logout() / handleSessionLost     -> cache wiped
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authService, type AuthUser } from '@/services/authService'
import { useAuthStore } from './auth'
import {
    clearUserCache,
    readUserCache,
    writeUserCache,
} from './userCache'

vi.mock('@/services/authService', () => ({
    authService: {
        me: vi.fn(),
        myPermissions: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
    },
}))

const _user = (overrides: Partial<AuthUser> = {}): AuthUser => ({
    id: 'usr_1',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Doe',
    role: 'user',
    status: 'active',
    authProvider: 'oidc',
    createdAt: '2026-05-20T00:00:00Z',
    updatedAt: '2026-05-20T00:00:00Z',
    ...overrides,
})

function _resetStore() {
    useAuthStore.setState({
        status: 'idle',
        isAuthenticated: false,
        user: null,
        permissions: { sid: '', global: [], ws: {} },
        error: null,
        isLoading: false,
    })
}

beforeEach(() => {
    sessionStorage.clear()
    _resetStore()
    vi.clearAllMocks()
})

afterEach(() => {
    sessionStorage.clear()
})

describe('useAuthStore.bootstrap with sessionStorage cache', () => {
    it('seeds authenticated state synchronously when the cache is warm', async () => {
        // Hold /me indefinitely so we can observe the *pre*-await state.
        let resolveMe: (v: { user: AuthUser }) => void = () => {}
        vi.mocked(authService.me).mockReturnValue(
            new Promise((r) => { resolveMe = r }),
        )
        vi.mocked(authService.myPermissions).mockResolvedValue({
            sid: 's1', global: [], ws: {},
        })

        writeUserCache(_user({ role: 'user' }))

        const bootstrapPromise = useAuthStore.getState().bootstrap()
        // Synchronously after bootstrap kicks off, the optimistic
        // cache seed must already have flipped status. main.tsx
        // depends on this being a sync transition (no `loading`).
        const seeded = useAuthStore.getState()
        expect(seeded.status).toBe('authenticated')
        expect(seeded.isAuthenticated).toBe(true)
        expect(seeded.user?.id).toBe('usr_1')

        // Finish /me with an upgraded role; the store updates +
        // cache refreshes with the new role.
        resolveMe({ user: _user({ role: 'admin' }) })
        await bootstrapPromise
        expect(useAuthStore.getState().user?.role).toBe('admin')
        expect(readUserCache()?.role).toBe('admin')
    })

    it('does not seed when the cache is cold (preserves loading state)', () => {
        let resolveMe: (v: { user: AuthUser }) => void = () => {}
        vi.mocked(authService.me).mockReturnValue(
            new Promise((r) => { resolveMe = r }),
        )

        void useAuthStore.getState().bootstrap()
        // No cache -> status drops to ``loading`` so main.tsx blocks
        // the shell render until /me resolves (status-quo behaviour).
        expect(useAuthStore.getState().status).toBe('loading')
        resolveMe({ user: _user() })
    })

    it('populates the cache after a successful cold-boot /me', async () => {
        vi.mocked(authService.me).mockResolvedValue({ user: _user() })
        vi.mocked(authService.myPermissions).mockResolvedValue({
            sid: 's1', global: [], ws: {},
        })

        await useAuthStore.getState().bootstrap()
        expect(readUserCache()?.id).toBe('usr_1')
    })

    it('wipes the cache and unauthenticates when /me fails', async () => {
        writeUserCache(_user())
        vi.mocked(authService.me).mockRejectedValue(new Error('401'))

        await useAuthStore.getState().bootstrap()
        expect(useAuthStore.getState().status).toBe('unauthenticated')
        expect(useAuthStore.getState().user).toBeNull()
        expect(readUserCache()).toBeNull()
    })

    it('writes the cache on successful login', async () => {
        vi.mocked(authService.login).mockResolvedValue({ user: _user() })
        vi.mocked(authService.myPermissions).mockResolvedValue({
            sid: 's1', global: [], ws: {},
        })

        const ok = await useAuthStore.getState().login('a@b.com', 'pw')
        expect(ok).toBe(true)
        expect(readUserCache()?.email).toBe('alice@example.com')
    })

    it('clears the cache on logout', async () => {
        writeUserCache(_user())
        vi.mocked(authService.logout).mockResolvedValue({ ok: true })

        await useAuthStore.getState().logout()
        expect(readUserCache()).toBeNull()
        expect(useAuthStore.getState().status).toBe('unauthenticated')
    })

    it('clears the cache on handleSessionLost', () => {
        writeUserCache(_user())
        useAuthStore.getState().handleSessionLost()
        expect(readUserCache()).toBeNull()
        expect(useAuthStore.getState().status).toBe('unauthenticated')
    })

    it('does not seed permissions from the cache (gates stay closed)', async () => {
        // A demoted user must NOT see stale admin gating between
        // optimistic-seed and /me-permissions resolution.
        writeUserCache(_user({ role: 'admin' }))
        let resolveMe: (v: { user: AuthUser }) => void = () => {}
        vi.mocked(authService.me).mockReturnValue(
            new Promise((r) => { resolveMe = r }),
        )

        void useAuthStore.getState().bootstrap()
        // Optimistic auth, but permissions still empty.
        expect(useAuthStore.getState().permissions.global).toEqual([])
        expect(useAuthStore.getState().can('system:admin')).toBe(false)
        resolveMe({ user: _user({ role: 'admin' }) })
    })

    afterEach(clearUserCache)
})

describe('applyProfile', () => {
    beforeEach(() => {
        _resetStore()
        clearUserCache()
    })

    it('merges the new fields into the session user', () => {
        useAuthStore.setState({
            status: 'authenticated', isAuthenticated: true, user: _user(),
        })

        useAuthStore.getState().applyProfile({
            firstName: 'Renamed', lastName: 'Person', displayName: 'Renamed Person',
        })

        const user = useAuthStore.getState().user!
        expect(user.firstName).toBe('Renamed')
        expect(user.displayName).toBe('Renamed Person')
        // Untouched fields have to survive: the profile endpoint returns
        // a narrower shape than AuthUser.
        expect(user.authProvider).toBe('oidc')
        expect(user.email).toBe('alice@example.com')
    })

    it('writes a cache entry that still validates on read', () => {
        // The regression the merge exists to prevent. Writing the PATCH
        // response verbatim would drop authProvider, which
        // ``_isValidUser`` requires — so the next read would silently
        // wipe the cache and bring back the blank-shell flash.
        useAuthStore.setState({
            status: 'authenticated', isAuthenticated: true, user: _user(),
        })

        useAuthStore.getState().applyProfile({ firstName: 'Cached' })

        const cached = readUserCache()
        expect(cached).not.toBeNull()
        expect(cached!.firstName).toBe('Cached')
        expect(cached!.authProvider).toBe('oidc')
    })

    it('does nothing when there is no session', () => {
        useAuthStore.getState().applyProfile({ firstName: 'Nobody' })

        expect(useAuthStore.getState().user).toBeNull()
        expect(readUserCache()).toBeNull()
    })
})
