/**
 * Signing out of one tab has to sign out the others.
 *
 * Cookies are shared across a browser profile, so the moment one tab
 * calls /logout every other tab's session is already gone — they just
 * don't know it. Before this they found out on their next request: up
 * to a poll interval if visible, indefinitely if hidden, and they got
 * there through the session-lost path, which reads to the user as an
 * error rather than as the sign-out they just performed next door.
 *
 * The two halves are tested separately because jsdom does not reliably
 * round-trip a BroadcastChannel between instances — see the note in
 * ``permissionChangeBus.test.ts``. Here: does logout announce it, and
 * does an announcement sign a receiving tab out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleSessionLost = vi.hoisted(() => vi.fn())
const notifySignedOut = vi.hoisted(() => vi.fn())

vi.mock('@/store/workspaces', () => ({
    useWorkspacesStore: { getState: () => ({ loadWorkspaces: vi.fn() }) },
}))

beforeEach(() => {
    handleSessionLost.mockClear()
    notifySignedOut.mockClear()
})

afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@/store/auth')
    vi.doUnmock('@/store/permissionChangeBus')
})

describe('a tab that receives the announcement', () => {
    it('signs out without making a request', async () => {
        // The announcing tab already called /logout and the cookies are
        // gone. A second /logout from here would be an unauthenticated
        // POST; tearing down local state is the entire job.
        vi.doMock('@/store/auth', () => ({
            useAuthStore: { getState: () => ({ handleSessionLost }) },
        }))
        const bus = await import('./permissionChangeBus')

        // Drive the channel handler the way a message from another tab
        // would, without depending on jsdom's cross-instance delivery.
        const channel = new BroadcastChannel('rbac-permissions')
        try {
            channel.postMessage({ kind: 'signed-out' })
            await vi.waitFor(() => expect(handleSessionLost).toHaveBeenCalled())
        } finally {
            channel.close()
        }
        expect(bus).toBeDefined()
    })

    it('ignores messages it does not recognise', async () => {
        // The channel is shared with the permission-change traffic, so
        // the kind tag is what keeps an unrelated message from signing
        // everyone out.
        vi.doMock('@/store/auth', () => ({
            useAuthStore: { getState: () => ({ handleSessionLost }) },
        }))
        await import('./permissionChangeBus')

        const channel = new BroadcastChannel('rbac-permissions')
        try {
            channel.postMessage({ kind: 'changed' })
            channel.postMessage({ something: 'else' })
            await new Promise((resolve) => setTimeout(resolve, 20))
        } finally {
            channel.close()
        }
        expect(handleSessionLost).not.toHaveBeenCalled()
    })
})

describe('the tab that signs out', () => {
    it('announces it', async () => {
        vi.doMock('@/store/permissionChangeBus', () => ({
            notifySignedOut,
            notifyPermissionsChanged: vi.fn(),
            PERMISSIONS_CHANGED_EVENT: 'permissions:changed',
        }))
        vi.doMock('@/services/authService', () => ({
            authService: { logout: vi.fn(async () => undefined) },
        }))
        const { useAuthStore } = await import('./auth')

        await useAuthStore.getState().logout()

        await vi.waitFor(() => expect(notifySignedOut).toHaveBeenCalledTimes(1))
        // And the local transition still happened — the announcement is
        // an addition to sign-out, not a replacement for it.
        expect(useAuthStore.getState().isAuthenticated).toBe(false)
    })
})
