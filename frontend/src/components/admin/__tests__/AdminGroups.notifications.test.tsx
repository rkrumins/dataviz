/**
 * Groups stops saying the same thing twice — and stops saying "Action failed".
 *
 * Every action on this page already spoke through the app's notification stack,
 * and then ALSO wrote the same words into an in-flow banner right under the KPI
 * row (the comment above it admitted as much: "Error banner (in addition to
 * notification)"). The banner stays for the one thing it is actually for — the
 * list would not load, which is still true while it is read.
 *
 * The fallback was one string, "Action failed", shared by create, rename and
 * delete alike: the only three cases where the server sending nothing readable
 * leaves the admin with no idea which of them just went wrong.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/groupsService', () => ({
    groupsService: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        listMembers: vi.fn(),
        addMember: vi.fn(),
        removeMember: vi.fn(),
    },
}))
vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn() },
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))

import { AdminGroups } from '../AdminGroups'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { adminUserService } from '@/services/adminUserService'
import { useNotificationStore } from '@/components/ui/notifications'

function group(over: Partial<GroupResponse> = {}): GroupResponse {
    return {
        id: 'grp_1',
        name: 'Data Stewards',
        description: 'Owns the lineage catalogue',
        source: 'local',
        externalId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        memberCount: 3,
        ...over,
    }
}

const raised = () => useNotificationStore.getState().notifications
const messages = () => raised().map(n => n.message)

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    vi.mocked(groupsService.list).mockResolvedValue([group()])
    vi.mocked(adminUserService.listUsers).mockResolvedValue([])
})

describe('AdminGroups — once, not twice', () => {
    it('a failed delete is raised on the stack and nowhere else', async () => {
        vi.mocked(groupsService.delete).mockRejectedValue(new Error('Group is in use by a mapping'))
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByTitle('Delete group'))
        // The row's icon button carries the same title as the modal's confirm;
        // the confirm is the one that arrives second.
        const confirms = await screen.findAllByRole('button', { name: 'Delete group' })
        await u.click(confirms[confirms.length - 1])

        await waitFor(() => expect(messages()).toEqual(['Group is in use by a mapping']))
        expect(screen.queryAllByText('Group is in use by a mapping')).toHaveLength(0)
    })

    it('names the group when the server sends no words of its own', async () => {
        vi.mocked(groupsService.delete).mockRejectedValue(new Error(''))
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByTitle('Delete group'))
        // The row's icon button carries the same title as the modal's confirm;
        // the confirm is the one that arrives second.
        const confirms = await screen.findAllByRole('button', { name: 'Delete group' })
        await u.click(confirms[confirms.length - 1])

        await waitFor(() => expect(messages()).toEqual(['Could not delete "Data Stewards".']))
        expect(messages()).not.toContain('Action failed')
    })
})

describe('AdminGroups — what stays on the page', () => {
    it('a failed load is still described inline', async () => {
        vi.mocked(groupsService.list).mockRejectedValue(new Error('Backend unavailable'))
        render(<AdminGroups />)

        expect(await screen.findByText('Backend unavailable')).toBeInTheDocument()
        expect(messages()).toEqual([])
    })
})
