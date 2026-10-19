/**
 * The Add-member user picker reaches every active account.
 *
 * It loaded the admin user list once — whose default page is fifty — and
 * filtered that in the browser, so anyone past the first fifty could not be
 * added to a workspace at all. It now asks the server for each page of
 * matches, searched by what the admin types. (A Super Admin's picker; for
 * everyone else it searches the people directory — see the steward tests.)
 */
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceMembersService', () => ({
    workspaceMembersService: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(),
        revoke: vi.fn(), previewRevoke: vi.fn(), grantOptions: vi.fn(),
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
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn(), approve: vi.fn(), deny: vi.fn(), route: vi.fn() },
}))
vi.mock('@/services/accessReviewsService', () => ({
    accessReviewsService: { list: vi.fn().mockResolvedValue([]) },
}))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { workspaceMembersService } from '@/services/workspaceMembersService'
import {
    adminUserService,
    type AdminUserResponse,
    type ListUsersParams,
} from '@/services/adminUserService'
import { accessRequestsService } from '@/services/accessRequestsService'
import { useAuthStore } from '@/store/auth'

function render(ui: ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

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
    vi.mocked(accessRequestsService.listToAnswer).mockResolvedValue([])
    vi.mocked(workspaceMembersService.grantOptions).mockResolvedValue({
        tier: 'admin', accessMode: 'app', groups: [], idpRoutes: [],
        roles: [
            { name: 'workspace_member', description: null, isSystem: true },
            { name: 'workspace_viewer', description: null, isSystem: true },
        ],
    })
    useAuthStore.setState({ permissions: { sid: 's', global: ['system:admin'], ws: {} } } as never)
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

    it('adds an exception only with an end, and says what the grant reads', async () => {
        const u = userEvent.setup()
        vi.mocked(workspaceMembersService.grantOptions).mockResolvedValue({
            tier: 'admin', accessMode: 'idp', groups: [], idpRoutes: [],
            roles: [{ name: 'workspace_viewer', description: null, isSystem: true }],
            dataSources: [{ id: 'ds_hr', label: 'HR warehouse', restricted: true }],
        })
        vi.mocked(workspaceMembersService.create).mockResolvedValue({} as never)
        render(<WorkspaceMembers workspaceId="ws_1" />)
        await u.click(await screen.findByRole('button', { name: 'Add member' }))
        await u.click(await screen.findByRole('button', { name: /Person 7\b/ }))

        expect(screen.getByRole('note')).toHaveTextContent('Any role here reads this workspace’s data source, which is restricted: HR warehouse.')
        expect(screen.queryByRole('button', { name: 'Permanent' })).not.toBeInTheDocument()
        expect(screen.getByText('An exception always ends: this one after 30d.')).toBeInTheDocument()
        await u.click(screen.getByRole('checkbox', { name: /Add them here as an exception/ }))
        await u.click(screen.getByRole('button', { name: 'Add to workspace' }))
        await waitFor(() => expect(workspaceMembersService.create).toHaveBeenCalledWith(
            'ws_1', expect.objectContaining({ subjectId: 'usr_7', expiresIn: '30d', exception: true }), expect.anything(),
        ))
    })
})
