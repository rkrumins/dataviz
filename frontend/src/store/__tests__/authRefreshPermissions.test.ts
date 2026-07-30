/**
 * One policy for the claims slice, applied in one place.
 *
 * There used to be three, and they disagreed about the only signal that
 * mattered — a successful response carrying no permissions:
 *
 *   * the poller refused to downgrade a real claim set to nothing;
 *   * ``hydratePermissions`` rotated the token once and then believed it;
 *   * the same function with ``skipAuthRefresh`` — every post-refresh
 *     re-hydrate, so every rotation — believed it immediately and blanked
 *     the UI, which the poller then un-blanked up to 60 s later. That
 *     round trip is what users reported as "it says I don't have
 *     permission, then the content loads".
 *
 * All three were guesses forced by an endpoint that decoded the access
 * token and so could not tell "this user holds nothing" from "I couldn't
 * work it out". ``GET /me/session`` resolves from the database, making
 * those two different outcomes on the wire — a 200 and a thrown error —
 * which is what lets one rule replace three heuristics:
 *
 *   * an answer is trusted, empty or not;
 *   * no answer keeps what we already knew, and reports ``error`` only
 *     when there was nothing to keep.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/services/authService', () => ({
    authService: { session: vi.fn(), refresh: vi.fn() },
}))

import { useAuthStore } from '@/store/auth'
import { authService } from '@/services/authService'

const REAL_CLAIMS = { sid: 's1', global: ['system:admin'], ws: {} }
const EMPTY_CLAIMS = { sid: '', global: [], ws: {} }
const session = authService.session as ReturnType<typeof vi.fn>

/** The wire shape, with the fields this suite doesn't exercise defaulted. */
function sessionState(permissions: unknown, over: Record<string, unknown> = {}) {
    return {
        user: {
            id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B',
            role: 'user', status: 'active', authProvider: 'local',
            createdAt: '', updatedAt: '',
        },
        permissions,
        accessExpiresAt: null,
        staleClaims: false,
        ...over,
    }
}

describe('refreshPermissions — a session that already knows its claims', () => {
    beforeEach(() => {
        session.mockReset()
        useAuthStore.setState({
            permissions: REAL_CLAIMS, permissionsStatus: 'ready',
        })
    })

    it('keeps existing claims when the resolve fails (no storm amplifier)', async () => {
        session.mockRejectedValueOnce(new Error('401'))
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissions).toEqual(REAL_CLAIMS)
    })

    it('stays ready when the resolve fails, instead of spinning forever', async () => {
        // We still hold a good answer, so there is nothing to wait for and
        // nothing to warn about. ``error`` is for having NO answer.
        session.mockRejectedValueOnce(new Error('boom'))
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissionsStatus).toBe('ready')
    })

    it('never sends a hydrated session back to loading', async () => {
        // The poller and the post-rotation re-resolve both call this in the
        // background. Dropping to 'loading' would blank a working UI on
        // every routine token rotation.
        let resolveState: (v: unknown) => void = () => {}
        session.mockReturnValueOnce(new Promise((r) => { resolveState = r }))

        const pending = useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissionsStatus).toBe('ready')

        resolveState(sessionState(REAL_CLAIMS))
        await pending
        expect(useAuthStore.getState().permissionsStatus).toBe('ready')
    })

    it('applies a genuine revocation without needing a rotation first', async () => {
        // The endpoint reads the database, so an empty answer means the
        // database says empty. No rotate-and-look-again dance, and no
        // ambiguity to guess at: believe it.
        const reduced = { sid: 's1', global: [], ws: {} }
        session.mockResolvedValueOnce(sessionState(reduced))

        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissions).toEqual(reduced)
        expect(useAuthStore.getState().permissionsStatus).toBe('ready')
    })

    it('forwards skipAuthRefresh so the re-resolve cannot recurse', async () => {
        session.mockResolvedValueOnce(sessionState(REAL_CLAIMS))
        await useAuthStore.getState().refreshPermissions({ skipAuthRefresh: true })
        expect(session).toHaveBeenCalledWith({ skipAuthRefresh: true })
    })

    it('takes the user DTO along, so a rename lands without a second call', async () => {
        session.mockResolvedValueOnce(
            sessionState(REAL_CLAIMS, {
                user: {
                    id: 'u1', email: 'a@b.c', firstName: 'Renamed', lastName: 'B',
                    role: 'user', status: 'active', authProvider: 'local',
                    createdAt: '', updatedAt: '',
                },
            }),
        )
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().user?.firstName).toBe('Renamed')
    })
})

describe('refreshPermissions — a session with nothing known yet', () => {
    beforeEach(() => {
        session.mockReset()
        useAuthStore.setState({
            permissions: EMPTY_CLAIMS, permissionsStatus: 'unknown',
        })
    })

    it('reports error — NOT ready — when the first resolve fails', async () => {
        // THE REGRESSION THIS FILE EXISTS FOR. This used to land on
        // 'ready' with an empty claim set, which every guard in the app
        // reads as a definitive denial. One rate-limited or timed-out
        // request during boot therefore painted "You don't have access"
        // over the whole UI, and left it there until a later poll
        // happened to succeed.
        session.mockRejectedValueOnce(new Error('429'))

        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissionsStatus).toBe('error')
        expect(useAuthStore.getState().permissionsStatus).not.toBe('ready')
    })

    it('recovers to ready on a later attempt', async () => {
        // 'error' has to be a state you can leave, or it is just a
        // differently-worded dead end. The poller is what retries.
        session.mockRejectedValueOnce(new Error('429'))
        await useAuthStore.getState().refreshPermissions()
        expect(useAuthStore.getState().permissionsStatus).toBe('error')

        session.mockResolvedValueOnce(sessionState(REAL_CLAIMS))
        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissionsStatus).toBe('ready')
        expect(useAuthStore.getState().permissions).toEqual(REAL_CLAIMS)
    })

    it('believes a legitimately empty answer, and calls that ready', async () => {
        // A user with no bindings is a real state, not a broken one. It
        // must not be confused with the failure above — which is the whole
        // reason the server distinguishes them now.
        session.mockResolvedValueOnce(sessionState(EMPTY_CLAIMS))

        await useAuthStore.getState().refreshPermissions()

        expect(useAuthStore.getState().permissionsStatus).toBe('ready')
    })
})
