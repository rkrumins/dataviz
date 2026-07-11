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
    authService: { myPermissions: vi.fn() },
}))

import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'

const REAL_CLAIMS = { sid: 's1', global: ['system:admin'], ws: {} }
const myPermissions = authService.myPermissions as ReturnType<typeof vi.fn>

describe('refreshPermissions', () => {
    beforeEach(() => {
        myPermissions.mockReset()
        useAuthStore.setState({ permissions: REAL_CLAIMS })
    })

    it('keeps existing claims when the permissions fetch fails (no storm amplifier)', async () => {
        myPermissions.mockRejectedValueOnce(new Error('401'))
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissions).toEqual(REAL_CLAIMS)
    })

    it('still applies a genuine revocation (200 with reduced claims)', async () => {
        const reduced = { sid: 's1', global: [], ws: {} }
        myPermissions.mockResolvedValueOnce(reduced)
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissions).toEqual(reduced)
    })

    it('forwards skipAuthRefresh so the re-hydrate cannot recurse', async () => {
        myPermissions.mockResolvedValueOnce(REAL_CLAIMS)
        await useAuthStore.getState().refreshPermissions({ skipAuthRefresh: true })
        expect(myPermissions).toHaveBeenCalledWith({ skipAuthRefresh: true })
    })
})
