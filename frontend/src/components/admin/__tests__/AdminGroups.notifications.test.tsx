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

describe('AdminGroups — the membership modal speaks the same way', () => {
    const MEMBER = { userId: 'usr_1', groupId: 'grp_1', addedAt: new Date().toISOString(), addedBy: null, source: 'local' }
    const USER = {
        id: 'usr_1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace',
        displayName: 'Ada Lovelace', status: 'active', role: 'member',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        resetRequested: false, mustChangePassword: false, hasPassword: true,
        signupSource: 'admin_created', identities: [], isSystemAccount: false,
    }

    async function openMembers() {
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByTitle('Manage members'))
        return u
    }

    it('names the person and the group when a failed removal carries no message', async () => {
        // A 502 over HTTP/2 has an empty statusText, so the extractor yields ''
        // and `new Error('')` is still an Error — an unguarded `err.message`
        // read renders an EMPTY red card for a failed membership change.
        vi.mocked(groupsService.listMembers).mockResolvedValue([MEMBER])
        vi.mocked(adminUserService.listUsers).mockResolvedValue([USER])
        vi.mocked(groupsService.removeMember).mockRejectedValue(new Error(''))

        const u = await openMembers()
        await u.click(await screen.findByTitle('Remove from group'))

        await waitFor(() => expect(messages()).toEqual([
            'Could not remove Ada Lovelace from "Data Stewards".',
        ]))
    })

    it('names the person and the group when a failed add carries no message', async () => {
        vi.mocked(groupsService.listMembers).mockResolvedValue([])
        vi.mocked(adminUserService.listUsers).mockResolvedValue([USER])
        vi.mocked(groupsService.addMember).mockRejectedValue(new Error(''))

        const u = await openMembers()
        await u.click(await screen.findByText('Ada Lovelace'))

        await waitFor(() => expect(messages()).toEqual([
            'Could not add Ada Lovelace to "Data Stewards".',
        ]))
    })

    it('names the group when the member list itself will not load', async () => {
        vi.mocked(groupsService.listMembers).mockRejectedValue(new Error(''))
        vi.mocked(adminUserService.listUsers).mockResolvedValue([USER])

        await openMembers()

        await waitFor(() => expect(messages()).toEqual([
            'Could not load the members of "Data Stewards".',
        ]))
    })

    it('says where the person went, not just that something happened', async () => {
        vi.mocked(groupsService.listMembers).mockResolvedValue([MEMBER])
        vi.mocked(adminUserService.listUsers).mockResolvedValue([USER])
        vi.mocked(groupsService.removeMember).mockResolvedValue(undefined)

        const u = await openMembers()
        await u.click(await screen.findByTitle('Remove from group'))

        await waitFor(() => expect(messages()).toEqual([
            'Removed Ada Lovelace from "Data Stewards".',
        ]))
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
