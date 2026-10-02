/**
 * You can see who is in a group.
 *
 * The Members column was a bare number, and the only route to the people
 * behind it was the "Manage members" button — an EDIT flow you had to enter
 * to answer a READ question. Worse, the list you got there was frequently
 * wrong: it resolved names by fetching the admin user list and joining in
 * JS, and that list returns its 50 newest accounts and is gated on
 * `system:admin`. An older member showed as a bare `usr_…` id; a delegated
 * groups admin (`org_admin` holds `system:groups:manage`, not
 * `system:admin`) got a 403 and watched a spinner forever.
 *
 * So: faces on the row, a drawer that opens on the list, and identities
 * that come from the membership endpoint itself.
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
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: vi.fn() }))
// Deliberately UNAVAILABLE. Nothing on this page may need it to name a
// member — that dependency is the bug this file exists to keep out.
vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listUsers: vi.fn().mockRejectedValue(new Error('403: admin access required')),
    },
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))

import { AdminGroups } from '../AdminGroups'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { searchDirectory } from '@/services/userDirectoryService'
import { adminUserService } from '@/services/adminUserService'

function group(over: Partial<GroupResponse> = {}): GroupResponse {
    return {
        id: 'grp_1',
        name: 'Data Stewards',
        description: 'Owns the lineage catalogue',
        source: 'local',
        externalId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        memberCount: 5,
        memberPreview: [
            { id: 'usr_1', displayName: 'Ada Lovelace' },
            { id: 'usr_2', displayName: 'Grace Hopper' },
        ],
        ...over,
    }
}

const member = (over = {}) => ({
    userId: 'usr_1',
    groupId: 'grp_1',
    addedAt: new Date().toISOString(),
    addedBy: null,
    source: 'local',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    status: 'active',
    deleted: false,
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/admin/groups')
    vi.mocked(groupsService.list).mockResolvedValue([group()])
    vi.mocked(groupsService.listMembers).mockResolvedValue([member()])
    vi.mocked(searchDirectory).mockResolvedValue({ users: [], groups: [] })
})

describe('the groups table shows WHO, not just how many', () => {
    it('names the members on the row itself, before anything is clicked', async () => {
        render(<AdminGroups />)
        // The count is still there, and now it says what it counts.
        expect(await screen.findByRole('button', {
            name: /5 members in Data Stewards\. View all\./,
        })).toBeInTheDocument()
        // Two faces are previewed; the other three collapse into a chip.
        expect(screen.getByText('+3')).toBeInTheDocument()
    })

    it('says "None yet" rather than drawing an empty stack', async () => {
        vi.mocked(groupsService.list).mockResolvedValue([
            group({ memberCount: 0, memberPreview: [] }),
        ])
        render(<AdminGroups />)
        expect(await screen.findByRole('button', {
            name: /No members in Data Stewards/,
        })).toBeInTheDocument()
    })
})

describe('the members drawer', () => {
    it('opens on the LIST — no add flow to enter first', async () => {
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByRole('button', { name: /5 members in Data Stewards/ }))

        // The person is there, named and reachable, with no further clicks.
        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.getByText('ada@example.com')).toBeInTheDocument()
        // And the picker is NOT what greeted them.
        expect(screen.queryByLabelText('Search people to add')).not.toBeInTheDocument()
    })

    it('names its members without the admin user list', async () => {
        // The regression: this used to `Promise.all` the member list with
        // the admin user list, so a 403 on the latter stranded BOTH panes
        // on their spinners for anyone short of `system:admin`.
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByRole('button', { name: /5 members in Data Stewards/ }))

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(adminUserService.listUsers).not.toHaveBeenCalled()
    })

    it('keeps the raw id when the server could not resolve it', async () => {
        // An account removed out from under a membership row. The row still
        // ships so an admin can clear it, and inventing a name over the id
        // would claim a fact nobody has.
        vi.mocked(groupsService.listMembers).mockResolvedValue([
            member({ userId: 'usr_gone', displayName: null, email: null, status: null }),
        ])
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByRole('button', { name: /5 members in Data Stewards/ }))

        expect(await screen.findByText('usr_gone')).toBeInTheDocument()
        expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument()
    })

    it('offers a way back when the list will not load, instead of spinning', async () => {
        vi.mocked(groupsService.listMembers).mockRejectedValue(new Error('boom'))
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByRole('button', { name: /5 members in Data Stewards/ }))

        expect(await screen.findByText('Members could not be loaded')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
    })

    it('closes on Escape', async () => {
        const u = userEvent.setup()
        render(<AdminGroups />)
        await u.click(await screen.findByRole('button', { name: /5 members in Data Stewards/ }))
        await screen.findByText('Ada Lovelace')

        await u.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })
})

describe('deep link', () => {
    it('?group= opens that group straight onto its membership', async () => {
        window.history.replaceState({}, '', '/admin/groups?group=grp_1')
        render(<AdminGroups />)

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.getByRole('dialog')).toHaveAttribute(
            'aria-label', 'Members of Data Stewards',
        )
    })

    it('ignores an id that matches no group', async () => {
        window.history.replaceState({}, '', '/admin/groups?group=grp_nope')
        render(<AdminGroups />)

        await screen.findByRole('button', { name: /5 members in Data Stewards/ })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
