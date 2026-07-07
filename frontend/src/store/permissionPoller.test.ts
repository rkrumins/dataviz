/**
 * Tests for the 60s permission poller.
 *
 * The poller's job is twofold:
 *
 *   1. Detect when the user's permissions have shifted (the JWT was
 *      rotated by the silent-refresh path in another action, or an
 *      admin revoked the session and a refresh has now landed).
 *   2. On change, fan out updates: write the new claims to the auth
 *      store, blanket-invalidate React Query, and call the change
 *      bus so the Zustand workspaces store + permission-aware pages
 *      refetch.
 *
 * On a stable claims response the poller MUST be a silent no-op —
 * any side effect on each tick would flood downstream UIs with
 * pointless re-renders.
 *
 * The test imports the poller's internal ``pollOnce`` reactively
 * because the public API only exposes ``enablePermissionPolling``,
 * which schedules a real setTimeout. To exercise a single tick
 * deterministically we re-export ``pollOnce`` only when testing —
 * see the ``__test`` export added below.
 */
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest'

import type { PermissionClaims } from '@/services/authService'

// Mocks must be hoisted ABOVE the module under test so its top-level
// imports see them. Typed as a function-returning-Promise so the
// resolved-value mocks below get the right inference.
const myPermissionsMock = vi.fn<() => Promise<PermissionClaims>>()
vi.mock('@/services/authService', () => ({
    authService: { myPermissions: myPermissionsMock },
}))

const setPermissionsMock = vi.fn()
vi.mock('@/store/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/store/auth')>()
    return {
        ...actual,
        // Only the store is stubbed; ``claimsSnapshot`` stays the real
        // export so the permuted-keys test exercises the actual shared
        // canonicalizer the poller uses in production.
        useAuthStore: {
            getState: () => ({ setPermissions: setPermissionsMock }),
        },
    }
})

const invalidateQueriesMock = vi.fn(async () => undefined)
vi.mock('@/main', () => ({
    getQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}))

const notifyPermissionsChangedMock = vi.fn(async () => undefined)
vi.mock('./permissionChangeBus', () => ({
    notifyPermissionsChanged: notifyPermissionsChangedMock,
}))


beforeEach(async () => {
    myPermissionsMock.mockReset()
    setPermissionsMock.mockReset()
    invalidateQueriesMock.mockReset()
    notifyPermissionsChangedMock.mockReset()
    // Reset module state between tests so ``lastSnapshot`` doesn't
    // leak. ``vi.resetModules()`` forces a fresh load of the poller
    // module on each ``await import('./permissionPoller')`` below.
    vi.resetModules()
})

afterEach(() => {
    vi.useRealTimers()
})


async function loadPoller() {
    return (await import('./permissionPoller')) as unknown as {
        // Test-only escape hatch — the module exports ``pollOnce``
        // when ``__POLLER_TEST_EXPORT__`` is set so we don't have to
        // wait for a real setTimeout tick.
        __pollOnce__: () => Promise<void>
    }
}


describe('permissionPoller.pollOnce', () => {
    it('updates the store + invalidates queries + notifies on change', async () => {
        myPermissionsMock
            .mockResolvedValueOnce({ sid: 's1', global: ['system:admin'], ws: {} })
            .mockResolvedValueOnce({ sid: 's1', global: [], ws: { ws_a: ['workspace:view:read'] } })
        const mod = await loadPoller()

        // First tick — claims observed for the first time, snapshot
        // recorded. Even though there is "no previous", the bus runs
        // because the poller treats the first tick as a change.
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(1)
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(1)

        // Second tick — DIFFERENT claims → another fan-out.
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(2)
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(2)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(2)
    })

    it('is a silent no-op when claims are stable across ticks', async () => {
        const stable = { sid: 's1', global: ['system:admin'], ws: {} }
        myPermissionsMock.mockResolvedValue(stable)
        const mod = await loadPoller()

        // First tick records the snapshot AND emits one set of
        // updates (it's a "change" relative to the empty baseline).
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(1)

        // Second + third ticks see the same payload → no further
        // updates. This is the property that keeps a quiet
        // permission tree from flooding subscribers every minute.
        await mod.__pollOnce__()
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(1)
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(1)
    })

    it('treats equivalent claims with permuted keys as stable', async () => {
        // The poller's snapshot helper sorts arrays + object keys so a
        // server response that happens to come back with different
        // iteration order doesn't trigger a spurious change.
        myPermissionsMock
            .mockResolvedValueOnce({
                sid: 's1',
                global: ['system:admin', 'system:org-admin'],
                ws: { ws_a: ['workspace:view:read', 'workspace:view:edit'] },
            })
            .mockResolvedValueOnce({
                sid: 's1',
                global: ['system:org-admin', 'system:admin'],
                ws: { ws_a: ['workspace:view:edit', 'workspace:view:read'] },
            })
        const mod = await loadPoller()

        await mod.__pollOnce__()
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(1)
    })

    it('swallows network errors and stays in a usable state', async () => {
        myPermissionsMock
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({ sid: 's1', global: [], ws: {} })
        const mod = await loadPoller()

        await mod.__pollOnce__()
        expect(setPermissionsMock).not.toHaveBeenCalled()
        // The next tick succeeds — confirms a transient error
        // doesn't poison the snapshot or break the loop.
        await mod.__pollOnce__()
        expect(setPermissionsMock).toHaveBeenCalledTimes(1)
    })
})
