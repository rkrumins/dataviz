/**
 * A workspace admin binds groups — no Groups admin rights needed. The picker
 * searches the directory any signed-in user can (every live group the
 * server will bind), and a bound group opens to the people it lets in from
 * the workspace's own access list, not the Groups admin API
 * (``system:groups:manage``), which refused them both.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { members, directory, groups } = vi.hoisted(() => ({
    members: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(), revoke: vi.fn(),
        previewRevoke: vi.fn(), grantOptions: vi.fn(),
    },
    directory: vi.fn(),
    groups: { list: vi.fn(), listMembers: vi.fn() },
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: directory }))
vi.mock('@/services/adminUserService', () => ({ adminUserService: { listUsers: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: groups }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/accessReviewsService', () => ({ accessReviewsService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get: vi.fn(), update: vi.fn() } }))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { useAuthStore } from '@/store/auth'

function renderTab() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <WorkspaceMembers workspaceId="ws_fin" />
        </QueryClientProvider>,
    )
}

const forbidden = () => Promise.reject(new Error('Forbidden'))
const grant = (via: 'direct' | 'group', groupId: string | null = null) => ({
    role: 'workspace_viewer', via, bindingId: via === 'group' ? `bnd_${groupId}` : 'bnd_max',
    groupId, groupName: groupId, expiresAt: null,
})
const person = (userId: string, displayName: string, grants: ReturnType<typeof grant>[]) => ({
    userId, displayName, email: `${userId}@x.io`, avatarId: null, status: 'active', deleted: false,
    roles: ['workspace_viewer'], effectiveRole: 'workspace_viewer', grants,
})

beforeEach(() => {
    vi.clearAllMocks()
    // Admin of this workspace; no Groups admin rights.
    useAuthStore.setState({
        permissions: { sid: 's', global: [], ws: { ws_fin: ['workspace:admin', 'workspace:members:add'] } },
    } as never)
    members.list.mockResolvedValue([{
        bindingId: 'bnd_grp_risk', role: 'workspace_viewer', grantedAt: '2026-01-01T00:00:00Z', grantedBy: null,
        expiresAt: null, subject: { type: 'group', id: 'grp_risk', displayName: 'Risk analysts', secondary: null },
    }])
    members.grantOptions.mockResolvedValue({
        tier: 'admin', accessMode: 'app', groups: [], idpRoutes: [],
        roles: [{ name: 'workspace_viewer', description: null, isSystem: true }],
    })
    members.create.mockResolvedValue({})
    directory.mockResolvedValue({ users: [], groups: [{ id: 'grp_ops', name: 'Operations', memberCount: 4 }] })
    groups.list.mockImplementation(forbidden)
    groups.listMembers.mockImplementation(forbidden)
})

describe('WorkspaceMembers — groups, as a workspace admin', () => {
    it('finds a group in the directory and binds it', async () => {
        const user = userEvent.setup()
        renderTab()
        await user.click(await screen.findByRole('button', { name: 'Add member' }))
        await user.click(await screen.findByRole('button', { name: 'Group' }))

        await waitFor(() => expect(directory).toHaveBeenCalledWith('', { types: ['group'], limit: 50 }))
        await user.click(await screen.findByRole('button', { name: /Operations/ }))
        expect(screen.getByText('4 members')).toBeInTheDocument()
        await user.type(screen.getByPlaceholderText('Search groups...'), 'ops')
        await waitFor(() => expect(directory).toHaveBeenLastCalledWith('ops', { types: ['group'], limit: 50 }))

        await user.click(screen.getByRole('button', { name: 'Add to workspace' }))
        await waitFor(() => expect(members.create).toHaveBeenCalledWith('ws_fin', expect.objectContaining({
            subjectType: 'group', subjectId: 'grp_ops', role: 'workspace_viewer',
        }), expect.anything()))
        expect(groups.list).not.toHaveBeenCalled()
    })

    it('opens a bound group to the people it lets in, from the workspace access list', async () => {
        const user = userEvent.setup()
        members.listEffective.mockResolvedValue({
            users: [
                person('usr_ada', 'Ada Okafor', [grant('group', 'grp_risk')]),
                person('usr_max', 'Max Direct', [grant('direct')]),
                person('usr_ben', 'Ben Other', [grant('group', 'grp_other')]),
            ],
            totalUsers: 3, directUsers: 1, viaGroupUsers: 2,
        })
        renderTab()
        await user.click(await screen.findByRole('button', { name: 'Show members of Risk analysts' }))

        expect(await screen.findByText('Ada Okafor')).toBeInTheDocument()
        expect(screen.getByText(/1 member inherit the/)).toBeInTheDocument()
        expect(screen.queryByText('Max Direct')).not.toBeInTheDocument()
        expect(screen.queryByText('Ben Other')).not.toBeInTheDocument()
        expect(within(screen.getByRole('table')).queryByText(/Couldn't load/)).not.toBeInTheDocument()
        expect(members.listEffective).toHaveBeenCalledWith('ws_fin')
        expect(groups.listMembers).not.toHaveBeenCalled()
    })
})
