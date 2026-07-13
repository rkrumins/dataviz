/**
 * refreshPermissions — regression guard for the app-wide request storm.
 *
 * The storm was a self-sustaining loop: after a silent token refresh,
 * fetchWithTimeout re-hydrates permissions; a FAILED re-hydrate used to
 * zero claims to EMPTY, which defeated the before/after guard and fired a
 * blanket cache invalidation on every failure — amplifying one bad 401
 * into hundreds of requests. These tests pin the two fixes:
 *   1. a failed re-hydrate KEEPS the prior claims (no amplifier),
 *   2. skipAuthRefresh is forwarded so the re-hydrate can't recurse.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/services/authService', () => ({
    authService: { myPermissions: vi.fn(), refresh: vi.fn() },
}))

import { useAuthStore, resetClaimRecovery } from '@/store/auth'
import { authService } from '@/services/authService'

const REAL_CLAIMS = { sid: 's1', global: ['system:admin'], ws: {} }
const myPermissions = authService.myPermissions as ReturnType<typeof vi.fn>
const refresh = authService.refresh as ReturnType<typeof vi.fn>

describe('refreshPermissions', () => {
    beforeEach(() => {
        myPermissions.mockReset()
        refresh.mockReset()
        resetClaimRecovery()
        useAuthStore.setState({ permissions: REAL_CLAIMS })
    })

    it('keeps existing claims when the permissions fetch fails (no storm amplifier)', async () => {
        myPermissions.mockRejectedValueOnce(new Error('401'))
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissions).toEqual(REAL_CLAIMS)
    })

    it('still applies a genuine revocation (200 with reduced claims)', async () => {
        // A TOTAL revocation and a CLAIMLESS TOKEN look identical on the wire: both
        // are a 200 with nothing in it. We can't tell them apart from the payload, so
        // we rotate the token once — that re-resolves claims from the DB — and then
        // believe whatever comes back. If the user really has been stripped of
        // everything, the second answer is empty too, and the revocation lands. The
        // guarantee this test protects is unchanged; it just costs one rotation.
        const reduced = { sid: 's1', global: [], ws: {} }
        myPermissions
            .mockResolvedValueOnce(reduced)   // looks empty…
            .mockResolvedValueOnce(reduced)   // …and still empty after rotation → real
        refresh.mockResolvedValueOnce({ user: { id: 'u1' } })

        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissions).toEqual(reduced)
    })

    it('forwards skipAuthRefresh so the re-hydrate cannot recurse', async () => {
        myPermissions.mockResolvedValueOnce(REAL_CLAIMS)
        await useAuthStore.getState().refreshPermissions({ skipAuthRefresh: true })
        expect(myPermissions).toHaveBeenCalledWith({ skipAuthRefresh: true })
    })
})

describe('a claimless access token self-heals', () => {
    beforeEach(() => {
        myPermissions.mockReset()
        refresh.mockReset()
        resetClaimRecovery()
        useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} } })
    })

    it('rotates the token when the JWT carries no claims, instead of stranding the user', async () => {
        // /me/permissions DECODES the JWT, so a token minted without permission
        // claims answers 200-with-nothing. The user then sees every gated control
        // missing, and NO RELOAD FIXES IT — a reload reuses the same cookie. Only
        // logging out and back in did, which is what a user reported. Rotating the
        // token re-resolves claims from the DB and repairs the session in place.
        myPermissions
            .mockResolvedValueOnce({ sid: 's1', global: [], ws: {} })          // claimless token
            .mockResolvedValueOnce({ sid: 's2', global: ['system:admin'], ws: {} })  // after rotation
        refresh.mockResolvedValueOnce({ user: { id: 'u1' } })

        await useAuthStore.getState().refreshPermissions()

        expect(refresh).toHaveBeenCalledTimes(1)
        expect(useAuthStore.getState().permissions.global).toContain('system:admin')
    })

    it('does not rotate when the token already carries claims', async () => {
        myPermissions.mockResolvedValueOnce({ sid: 's1', global: ['system:admin'], ws: {} })

        await useAuthStore.getState().refreshPermissions()

        expect(refresh).not.toHaveBeenCalled()
    })

    it('accepts empty claims for a user who genuinely has none, after one attempt', async () => {
        // Rotation happened and the claims are STILL empty — that is a real state
        // (a user with no bindings), not a broken one. Don't loop.
        myPermissions
            .mockResolvedValueOnce({ sid: 's1', global: [], ws: {} })
            .mockResolvedValueOnce({ sid: 's2', global: [], ws: {} })
        refresh.mockResolvedValueOnce({ user: { id: 'u1' } })

        await useAuthStore.getState().refreshPermissions()
        await useAuthStore.getState().refreshPermissions()

        // One rotation for the whole page load — not one per hydrate.
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('keeps the empty claims when the rotation itself fails', async () => {
        myPermissions.mockResolvedValueOnce({ sid: 's1', global: [], ws: {} })
        refresh.mockRejectedValueOnce(new Error('refresh failed'))

        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissions.global).toEqual([])
    })
})
