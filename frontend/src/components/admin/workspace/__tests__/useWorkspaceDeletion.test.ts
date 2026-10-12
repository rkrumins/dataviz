/**
 * Deleting a workspace is the most destructive button on the page, and until now it
 * said NOTHING when it worked: the dialog closed and the row vanished. These pin the
 * two halves of the fix —
 *
 *   • a completed delete names what went with it (views, members, custom roles);
 *   • a PARTIAL fan-out — some deleted, some rejected — must never raise a success
 *     notification. There is no bulk endpoint, so partial is a real outcome, and
 *     "Deleted 4 workspaces" over three deletions is the one lie that matters here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWorkspaceDeletion } from '../useWorkspaceDeletion'
import type { WorkspaceResponse } from '@/services/workspaceService'

vi.mock('@/services/workspaceService', () => ({
    workspaceService: {
        getImpact: vi.fn(),
        delete: vi.fn(),
    },
}))
const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { workspaceService } from '@/services/workspaceService'

const EMPTY_IMPACT = { views: [], dataSources: [], memberCount: 0, customRoleCount: 0 }
const ws = (id: string, name: string) => ({ id, name } as WorkspaceResponse)

async function openOn(workspaces: WorkspaceResponse[], onDeleted = vi.fn()) {
    const { result } = renderHook(() => useWorkspaceDeletion(onDeleted))
    await act(async () => { await result.current.open(workspaces) })
    await waitFor(() => expect(result.current.target?.loading).toBe(false))
    return result
}

describe('deleting workspaces', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(workspaceService.getImpact).mockResolvedValue(EMPTY_IMPACT)
    })

    it('names the workspace, and what went with it', async () => {
        vi.mocked(workspaceService.delete).mockResolvedValue(undefined)
        const result = await openOn([ws('w1', 'Sales Analytics')])

        await act(async () => { await result.current.confirm() })

        expect(notify).toHaveBeenCalledTimes(1)
        const [type, message] = notify.mock.calls[0]
        expect(type).toBe('success')
        expect(message).toBe(
            'Deleted “Sales Analytics” — its views, members and custom roles went with it.')
    })

    it('counts them when several go at once', async () => {
        vi.mocked(workspaceService.delete).mockResolvedValue(undefined)
        const result = await openOn([ws('w1', 'Sales'), ws('w2', 'Finance'), ws('w3', 'Ops')])

        await act(async () => { await result.current.confirm() })

        expect(notify.mock.calls[0][1]).toBe(
            'Deleted 3 workspaces — their views, members and custom roles went with them.')
    })

    it('says NOTHING succeeded when a partial fan-out leaves some behind', async () => {
        vi.mocked(workspaceService.delete)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('409'))
        const onDeleted = vi.fn()
        const result = await openOn([ws('w1', 'Sales'), ws('w2', 'Finance')], onDeleted)

        // The dialog owns this failure — it stays open and renders the thrown message.
        await expect(act(async () => { await result.current.confirm() }))
            .rejects.toThrow('1 deleted, 1 failed')

        // ...and the list is still refreshed, because one of them really is gone.
        expect(onDeleted).toHaveBeenCalled()
        expect(notify).not.toHaveBeenCalled()
    })

    it('says nothing on a total failure either', async () => {
        vi.mocked(workspaceService.delete).mockRejectedValue(new Error('500'))
        const result = await openOn([ws('w1', 'Sales')])

        await expect(act(async () => { await result.current.confirm() }))
            .rejects.toThrow('Nothing was deleted')
        expect(notify).not.toHaveBeenCalled()
    })
})
