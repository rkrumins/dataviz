/**
 * The Add-member user picker reaches every active account.
 *
 * It loaded the admin user list once — whose default page is fifty — and
 * filtered that in the browser, so anyone past the first fifty could not be
 * added to a workspace at all. It now asks the server for each page of
 * matches, searched by what the admin types.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceMembersService', () => ({
    workspaceMembersService: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(),
        revoke: vi.fn(), previewRevoke: vi.fn(),
    },
}))
vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn() },
}))
vi.mock('@/services/groupsService', () => ({
    groupsService: { list: vi.fn(), listMembers: vi.fn() },
}))
vi.mock('@/services/permissionsService', () => ({
    permissionsService: { listRoles: vi.fn() },
}))
vi.mock('@/services/accessRequestsService', () => ({
    accessRequestsService: { listForWorkspace: vi.fn(), approve: vi.fn(), deny: vi.fn() },
}))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { workspaceMembersService } from '@/services/workspaceMembersService'
import {
    adminUserService,
    type AdminUserResponse,
    type ListUsersParams,
} from '@/services/adminUserService'
import { permissionsService } from '@/services/permissionsService'
import { accessRequestsService } from '@/services/accessRequestsService'

const listUsers = vi.mocked(adminUserService.listUsers)
const lastCall = () => listUsers.mock.lastCall?.[0]

function person(i: number): AdminUserResponse {
    return {
        id: `usr_${i}`, email: `person${i}@example.com`,
        firstName: 'Person', lastName: String(i), displayName: `Person ${i}`,
        status: 'active', role: 'user',
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
        resetRequested: false, mustChangePassword: false,
        hasPassword: true, signupSource: 'local_signup', identities: [],
        isSystemAccount: false,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    // Person 5 already holds the picker's default role here.
    vi.mocked(workspaceMembersService.list).mockResolvedValue([{
        bindingId: 'bnd_5', role: 'workspace_member',
        grantedAt: '2025-01-01T00:00:00Z', grantedBy: null, expiresAt: null,
        subject: { type: 'user', id: 'usr_5', displayName: 'Person 5', secondary: 'person5@example.com' },
    }])
    vi.mocked(accessRequestsService.listForWorkspace).mockResolvedValue([])
    vi.mocked(permissionsService.listRoles).mockResolvedValue([])
    // 60 active accounts on the server, 25 to a page.
    listUsers.mockImplementation(async ({ offset = 0, limit }: ListUsersParams) => ({
        items: Array.from({ length: Math.max(0, Math.min(limit, 60 - offset)) }, (_, i) => person(offset + i)),
        total: 60,
    }))
})

describe('Add member — the user picker', () => {
    it('asks the server for active users a page at a time, searched by what is typed', async () => {
        const u = userEvent.setup()
        render(<WorkspaceMembers workspaceId="ws_1" />)
        await u.click(await screen.findByRole('button', { name: 'Add member' }))

        await waitFor(() => expect(listUsers).toHaveBeenCalledWith({
            status: 'active', search: '', sort: 'name', order: 'asc', limit: 25, offset: 0,
        }))
        expect(await screen.findByText('Person 24')).toBeInTheDocument()
        expect(screen.getByText('Page 1 / 3')).toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Next page' }))
        expect(await screen.findByText('Person 49')).toBeInTheDocument()
        expect(lastCall()).toMatchObject({ offset: 25 })

        await u.type(screen.getByPlaceholderText('Search users...'), 'zed')
        await waitFor(() => expect(lastCall()).toMatchObject({ search: 'zed', offset: 0 }))
    })

    it('still flags a user who already holds the chosen role here', async () => {
        const u = userEvent.setup()
        render(<WorkspaceMembers workspaceId="ws_1" />)
        await u.click(await screen.findByRole('button', { name: 'Add member' }))

        await u.click(await screen.findByRole('button', { name: /Person 5\b/ }))
        expect(screen.getByText(/already holds the Workspace member role here/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Add to workspace' })).toBeDisabled()
    })
})
