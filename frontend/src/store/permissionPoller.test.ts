/**
 * Tests for the 60s session poller.
 *
 * The poller's job is twofold:
 *
 *   1. Detect when the user's permissions have shifted.
 *   2. On change, fan out updates: blanket-invalidate React Query and
 *      call the change bus so the Zustand workspaces store +
 *      permission-aware pages refetch.
 *
 * On a stable response the poller MUST be a silent no-op — any side
 * effect on each tick would flood downstream UIs with pointless
 * re-renders.
 *
 * WHAT MOVED. The poller no longer fetches or writes claims itself; it
 * calls ``refreshPermissions``, which goes through the store's single
 * ``applyClaims`` policy. It used to call ``setPermissions`` directly and
 * therefore carried its own opinion about an empty claim set — an opinion
 * that contradicted the store's, because both were guessing at an
 * endpoint that could not tell "holds nothing" from "couldn't tell".
 * Those guarantees are now pinned where the policy lives, in
 * ``__tests__/authRefreshPermissions.test.ts``; what is left here is what
 * is genuinely the poller's own: change detection and fan-out.
 *
 * The test imports the poller's internal ``pollOnce`` because the public
 * API only exposes ``enablePermissionPolling``, which schedules a real
 * setTimeout.
 */
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest'

import type { PermissionClaims } from '@/services/authService'

const EMPTY: PermissionClaims = { sid: '', global: [], ws: {} }

/** What the store currently holds — the poller reads this for its snapshot. */
let currentClaims: PermissionClaims = EMPTY
/** Answers ``refreshPermissions`` will apply, in order. A ``null`` entry
 *  models a failed resolve, which the real store handles by KEEPING the
 *  previous claims — so the poller must see no change and stay quiet. */
let pending: (PermissionClaims | null)[] = []

const refreshPermissionsMock = vi.fn(async () => {
    const next = pending.length > 0 ? pending.shift()! : null
    if (next !== null) currentClaims = next
})

vi.mock('@/store/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/store/auth')>()
    return {
        ...actual,
        // Only the store is stubbed; ``claimsSnapshot`` stays the real
        // export so the permuted-keys test exercises the actual shared
        // canonicalizer the poller uses in production.
        useAuthStore: {
            getState: () => ({
                refreshPermissions: refreshPermissionsMock,
                permissions: currentClaims,
            }),
        },
    }
})

const invalidateQueriesMock = vi.fn(async () => undefined)
vi.mock('@/lib/queryClient', () => ({
    getQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}))

const notifyPermissionsChangedMock = vi.fn(async () => undefined)
vi.mock('./permissionChangeBus', () => ({
    notifyPermissionsChanged: notifyPermissionsChangedMock,
}))


beforeEach(async () => {
    refreshPermissionsMock.mockClear()
    currentClaims = EMPTY
    pending = []
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
        enablePermissionPolling: () => void
        __pollOnce__: () => Promise<void>
    }
}

/**
 * Seed the change-detection baseline from the store without starting a
 * live chain.
 *
 * ``enablePermissionPolling`` seeds and then fires a tick of its own,
 * which would consume a queued answer and race the explicit ticks these
 * tests drive. Enabling while hidden gives us the seed alone — the
 * ordering is deliberate in the poller (seed above the visibility check)
 * precisely so a tab that boots hidden gets an accurate baseline.
 */
async function loadPollerSeeded() {
    const hidden = vi.spyOn(document, 'hidden', 'get')
    hidden.mockReturnValue(true)
    const mod = await loadPoller()
    mod.enablePermissionPolling()
    hidden.mockRestore()
    return mod
}


describe('permissionPoller.pollOnce', () => {
    it('invalidates queries + notifies on change', async () => {
        pending = [
            { sid: 's1', global: ['system:admin'], ws: {} },
            { sid: 's1', global: [], ws: { ws_a: ['workspace:view:read'] } },
        ]
        const mod = await loadPoller()

        // First tick — claims observed for the first time, snapshot
        // recorded. Even though there is "no previous", the bus runs
        // because the poller treats the first tick as a change.
        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(1)

        // Second tick — DIFFERENT claims → another fan-out.
        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(2)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(2)
    })

    it('is a silent no-op when claims are stable across ticks', async () => {
        const stable = { sid: 's1', global: ['system:admin'], ws: {} }
        pending = [stable, stable, stable]
        const mod = await loadPoller()

        // First tick records the snapshot AND emits one set of
        // updates (it's a "change" relative to the empty baseline).
        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)

        // Second + third ticks see the same payload → no further
        // updates. This is the property that keeps a quiet
        // permission tree from flooding subscribers every minute.
        await mod.__pollOnce__()
        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(1)
    })

    it('treats equivalent claims with permuted keys as stable', async () => {
        // The snapshot helper sorts arrays + object keys so a server
        // response that happens to come back with different iteration
        // order doesn't trigger a spurious change.
        pending = [
            {
                sid: 's1',
                global: ['system:admin', 'system:org-admin'],
                ws: { ws_a: ['workspace:view:read', 'workspace:view:edit'] },
            },
            {
                sid: 's1',
                global: ['system:org-admin', 'system:admin'],
                ws: { ws_a: ['workspace:view:edit', 'workspace:view:read'] },
            },
        ]
        const mod = await loadPoller()

        await mod.__pollOnce__()
        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
    })

    it('stays quiet through a failed resolve, then picks up the next one', async () => {
        // A failed resolve keeps the previous claims (the store's policy),
        // so the snapshot is unchanged and the poller must NOT fan out.
        // Firing an unfiltered invalidation on every failed tick is the
        // amplifier that turned one bad request into a request storm.
        //
        // Seeded via ``enablePermissionPolling`` because that is how
        // production starts: the baseline comes from an already-resolved
        // store, so a tick that learns nothing new diffs to nothing.
        currentClaims = { sid: 's1', global: ['system:admin'], ws: {} }
        pending = [null, { sid: 's1', global: ['system:org-admin'], ws: {} }]
        const mod = await loadPollerSeeded()

        await mod.__pollOnce__()
        expect(invalidateQueriesMock).not.toHaveBeenCalled()

        await mod.__pollOnce__()
        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
    })

    it('applies a real revocation, including one that empties the set', async () => {
        // A 200 carrying nothing means the DATABASE says nothing — a real
        // state a user can hold. The poller used to refuse this, because
        // the endpoint it polled could not distinguish it from a failure.
        // It can now, so refusing would suppress a genuine revocation.
        currentClaims = { sid: 's1', global: ['system:admin'], ws: {} }
        pending = [{ sid: 's1', global: [], ws: {} }]
        const mod = await loadPollerSeeded()

        await mod.__pollOnce__()

        expect(invalidateQueriesMock).toHaveBeenCalledTimes(1)
        expect(notifyPermissionsChangedMock).toHaveBeenCalledTimes(1)
    })
})


describe('seeding when the tab boots hidden', () => {
    /**
     * A tab that is hidden at mount — session restore, cmd-click, opened
     * in the background — used to return from ``enablePermissionPolling``
     * before ``lastSnapshot`` was seeded, because the visibility check sat
     * above the assignment. Its first poll after focus then diffed a real
     * claim set against ``''``, "detected" a change that had not happened,
     * and ran the unfiltered invalidate plus the cross-tab broadcast.
     * Restoring a window of ten tabs paid that on every one.
     */
    it('does not report a change on the first poll after focus', async () => {
        const claims: PermissionClaims = {
            sid: 's1', global: ['system:admin'], ws: {},
        }
        currentClaims = claims
        pending = [claims, claims]

        const hidden = vi.spyOn(document, 'hidden', 'get')
        hidden.mockReturnValue(true)

        const mod = await loadPoller()
        mod.enablePermissionPolling()

        hidden.mockReturnValue(false)
        await mod.__pollOnce__()

        expect(invalidateQueriesMock).not.toHaveBeenCalled()
        expect(notifyPermissionsChangedMock).not.toHaveBeenCalled()
        hidden.mockRestore()
    })

    it('still reports a genuine change made while the tab was hidden', async () => {
        // The seed must not blind the poller. If an admin changes a role
        // while the tab is backgrounded, the first poll after focus has
        // to diff against the seeded baseline and fire.
        currentClaims = { sid: 's1', global: ['system:admin'], ws: {} }
        pending = [{ sid: 's1', global: ['system:org-admin'], ws: {} }]

        const hidden = vi.spyOn(document, 'hidden', 'get')
        hidden.mockReturnValue(true)

        const mod = await loadPoller()
        mod.enablePermissionPolling()

        hidden.mockReturnValue(false)
        await mod.__pollOnce__()

        expect(invalidateQueriesMock).toHaveBeenCalled()
        expect(notifyPermissionsChangedMock).toHaveBeenCalled()
        hidden.mockRestore()
    })
})
