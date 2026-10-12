/**
 * What a session response tells the app about a pending password change.
 *
 * The account's flag (``user.mustChangePassword``) says its local password
 * was chosen by somebody else. Whether THIS session has to change it first
 * is the response's ``passwordChangeRequired`` — false for a session signed
 * in through SSO — and that is what the signed-in user carries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchWithTimeout = vi.fn()

vi.mock('./fetchWithTimeout', () => ({
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
    adoptEnvironmentId: () => {},
    adoptServerClock: () => {},
}))

import { authService } from './authService'

function answer(body: unknown) {
    fetchWithTimeout.mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
}

const user = (mustChangePassword: boolean) => ({
    id: 'usr_1', email: 'dana@example.com', firstName: 'Dana', lastName: 'S',
    role: 'user', status: 'active', authProvider: 'oidc', createdAt: '', updatedAt: '',
    mustChangePassword,
})

beforeEach(() => fetchWithTimeout.mockReset())

describe('adopting a session', () => {
    it('lets an SSO session through while the account password is pending', async () => {
        answer({ user: user(true), passwordChangeRequired: false })
        const { user: me } = await authService.me()
        expect(me.mustChangePassword).toBe(true)
        expect(me.passwordChangeRequired).toBe(false)
    })

    it('holds a session that signed in with the password', async () => {
        answer({ user: user(true), passwordChangeRequired: true })
        expect((await authService.me()).user.passwordChangeRequired).toBe(true)
    })

    it('falls back to the account flag when the server does not say', async () => {
        answer({ user: user(true) })
        expect((await authService.me()).user.passwordChangeRequired).toBe(true)
    })
})
