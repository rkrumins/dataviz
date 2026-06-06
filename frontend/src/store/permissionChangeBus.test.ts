/**
 * Tests for the permission-change event bus.
 *
 * The bus is the single funnel called after a permission change is
 * detected. Two responsibilities are under test:
 *
 *   1. Dispatch the ``permissions:changed`` window event so any
 *      page-level cache (WorkspacesPage, IngestionPage, AdminUsers,
 *      WorkspaceMembers) that wants to refresh can listen.
 *   2. Reload the Zustand workspaces store so the CommandPalette +
 *      anyone reading ``s.workspaces`` repaints with the
 *      filtered-by-new-claims list.
 *
 * The cross-tab BroadcastChannel hop is intentionally not tested
 * here — jsdom's BroadcastChannel shim doesn't reliably round-trip
 * between two instances; that's covered manually in the verification
 * checklist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { notifyPermissionsChanged, PERMISSIONS_CHANGED_EVENT } from './permissionChangeBus'

// Mock the workspaces store so we can assert ``loadWorkspaces`` was
// called without actually hitting workspaceService.list().
const loadWorkspacesMock = vi.fn(async () => undefined)
vi.mock('@/store/workspaces', () => ({
    useWorkspacesStore: {
        getState: () => ({ loadWorkspaces: loadWorkspacesMock }),
    },
}))

afterEach(() => {
    loadWorkspacesMock.mockClear()
})


describe('notifyPermissionsChanged', () => {
    it('dispatches the permissions:changed window event', async () => {
        const listener = vi.fn()
        window.addEventListener(PERMISSIONS_CHANGED_EVENT, listener)
        try {
            await notifyPermissionsChanged()
            expect(listener).toHaveBeenCalledTimes(1)
            // Event type matches the exported constant so subscribers
            // and the publisher can never silently drift apart.
            const arg = listener.mock.calls[0]?.[0] as CustomEvent | undefined
            expect(arg?.type).toBe(PERMISSIONS_CHANGED_EVENT)
        } finally {
            window.removeEventListener(PERMISSIONS_CHANGED_EVENT, listener)
        }
    })

    it('reloads the workspaces store', async () => {
        await notifyPermissionsChanged()
        expect(loadWorkspacesMock).toHaveBeenCalledTimes(1)
    })

    it('still dispatches the window event when the store reload throws', async () => {
        // Best-effort guarantee — a flaky store mustn't kill the
        // window event other subscribers depend on.
        loadWorkspacesMock.mockRejectedValueOnce(new Error('boom'))
        const listener = vi.fn()
        window.addEventListener(PERMISSIONS_CHANGED_EVENT, listener)
        try {
            await notifyPermissionsChanged()
            expect(listener).toHaveBeenCalledTimes(1)
        } finally {
            window.removeEventListener(PERMISSIONS_CHANGED_EVENT, listener)
        }
    })
})
