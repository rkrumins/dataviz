/**
 * Proactive session renewal.
 *
 * Renewal used to be entirely reactive — something had to 401 first — and
 * the only authenticated request still firing in an idle tab was the
 * 60-second permission poll, which doubled as the keepalive and which
 * pauses while the tab is hidden. So the exact case users reported, a
 * page left open a long time, was the case with nothing keeping it alive.
 *
 * These pin the two decisions the module makes and the two loops it must
 * not enter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshMock = vi.fn(async () => ({ user: {} }))
vi.mock('@/services/authService', () => ({
    authService: { refresh: refreshMock },
}))

const refreshPermissionsMock = vi.fn(async () => undefined)
vi.mock('@/store/auth', () => ({
    useAuthStore: {
        getState: () => ({ refreshPermissions: refreshPermissionsMock }),
    },
}))

beforeEach(() => {
    vi.resetModules()
    refreshMock.mockClear()
    refreshPermissionsMock.mockClear()
})

async function load() {
    return await import('./sessionRenewal')
}

const NOW = 1_800_000_000_000
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString()


describe('renewalDelayMs', () => {
    it('renews partway through the token\'s life, not at the end', async () => {
        const { renewalDelayMs } = await load()
        // 15 minutes of life → renew around minute 10, leaving real slack
        // for a slow or failed rotation to be retried inside.
        const delay = renewalDelayMs(iso(15 * 60_000), NOW)
        expect(delay).toBeGreaterThan(9 * 60_000)
        expect(delay).toBeLessThan(11 * 60_000)
    })

    it('declines to schedule for a token that is already expired', async () => {
        // Racing the reactive 401 path buys nothing and risks two
        // rotations for one expiry.
        const { renewalDelayMs } = await load()
        expect(renewalDelayMs(iso(-60_000), NOW)).toBeNull()
    })

    it('declines when the server did not say when the token expires', async () => {
        // Null is the documented "renew reactively" fallback, so an
        // unreadable token degrades to the old behaviour rather than
        // breaking the boot.
        const { renewalDelayMs } = await load()
        expect(renewalDelayMs(null, NOW)).toBeNull()
        expect(renewalDelayMs('not-a-date', NOW)).toBeNull()
    })

    it('caps an absurd expiry rather than trusting it', async () => {
        const { renewalDelayMs } = await load()
        const delay = renewalDelayMs(iso(365 * 24 * 60 * 60_000), NOW)
        expect(delay).toBeLessThanOrEqual(30 * 60_000)
    })
})


describe('onSessionResolved', () => {
    it('rotates when the database and the token disagree', async () => {
        const mod = await load()
        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
    })

    it('does not rotate when they agree', async () => {
        const mod = await load()
        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: false })
        expect(refreshMock).not.toHaveBeenCalled()
    })

    it('gives up after one rotation if the disagreement persists', async () => {
        // A rotation re-mints the token from the same resolver the session
        // endpoint read, so one attempt should always settle it. If it does
        // not, the two differ for a structural reason a rotation cannot
        // fix — and rotating on every poll would be an unbounded loop
        // against /auth/refresh, which is the self-inflicted request storm
        // this whole change exists to end.
        const mod = await load()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })

        expect(refreshMock).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    it('restores the budget once a resolve comes back in agreement', async () => {
        // The budget must reset on AGREEMENT, not on every resolve.
        // Resetting it in scheduleSessionRenewal — the obvious place —
        // would hand a fresh budget to the very resolve reporting the
        // disagreement, and the cap would never bite.
        const mod = await load()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: false })

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2))
        warn.mockRestore()
    })
})


describe('cancelSessionRenewal', () => {
    it('stops a rotation that is already awaiting the network', async () => {
        // A rotation parked in flight holds no timer handle, so
        // clearTimeout cannot reach it. Without the epoch it would wake up
        // after logout and re-resolve the session it was told to abandon.
        const mod = await load()
        let finishRefresh: () => void = () => {}
        refreshMock.mockReturnValueOnce(
            new Promise<{ user: object }>((r) => {
                finishRefresh = () => r({ user: {} })
            }),
        )

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))

        mod.cancelSessionRenewal()
        finishRefresh()
        await Promise.resolve()
        await Promise.resolve()

        expect(refreshPermissionsMock).not.toHaveBeenCalled()
    })

    it('leaves the session alone when the rotation itself fails', async () => {
        // A rotation that could not happen is not a session that has
        // ended: the token is valid until exp and the 401 path is still
        // there. Signing the user out on a network blip is the
        // over-reaction that used to log people out at random.
        const mod = await load()
        refreshMock.mockRejectedValueOnce(new Error('offline'))

        mod.onSessionResolved({ accessExpiresAt: null, staleClaims: true })
        await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
        await Promise.resolve()

        expect(refreshPermissionsMock).not.toHaveBeenCalled()
    })
})
