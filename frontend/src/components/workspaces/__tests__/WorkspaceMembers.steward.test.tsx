/**
 * A steward's Members tab: they add people (picked from the directory any
 * signed-in user can search) as Viewer or Member; removing people, binding
 * groups and the access settings stay with admins. Where the identity
 * provider decides who is in, adding a person is an exception — the admins'.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { members, directory } = vi.hoisted(() => ({
    members: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(), revoke: vi.fn(),
        previewRevoke: vi.fn(), grantOptions: vi.fn(),
    },
    directory: vi.fn(),
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory: directory }))
vi.mock('@/services/adminUserService', () => ({ adminUserService: { listUsers: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: { list: vi.fn(), listMembers: vi.fn() } }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get: vi.fn(), update: vi.fn() } }))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { adminUserService } from '@/services/adminUserService'
import { useAuthStore } from '@/store/auth'

function renderTab(canManage: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <WorkspaceMembers workspaceId="ws_fin" canManage={canManage} />
        </QueryClientProvider>,
    )
}

const STEWARD_OPTIONS = {
    tier: 'steward', accessMode: 'app', groups: [], idpRoutes: [],
    roles: [
        { name: 'workspace_viewer', description: null, isSystem: true },
        { name: 'workspace_member', description: null, isSystem: true },
    ],
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { sid: 's', global: [], ws: { ws_fin: ['workspace:members:add'] } } } as never)
    members.list.mockResolvedValue([{
        bindingId: 'bnd_1', role: 'workspace_member', grantedAt: '2026-01-01T00:00:00Z', grantedBy: null, expiresAt: null,
        subject: { type: 'user', id: 'usr_max', displayName: 'Max', secondary: 'max@x.io' },
    }])
    members.grantOptions.mockResolvedValue(STEWARD_OPTIONS)
    members.create.mockResolvedValue({})
    directory.mockResolvedValue({ users: [{ id: 'usr_ana', displayName: 'Ana T', email: 'ana@x.io' }], groups: [] })
})

describe('WorkspaceMembers — as a steward', () => {
    it('adds people from the directory, never removes or binds groups', async () => {
        const user = userEvent.setup()
        renderTab(false)

        expect(await screen.findByText('Max')).toBeInTheDocument()
        expect(screen.getByText(/As a steward you let people in/)).toBeInTheDocument()
        expect(screen.queryByTitle('Revoke binding')).not.toBeInTheDocument()
        expect(screen.queryByText('How people get in')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Add member' }))
        await waitFor(() => expect(directory).toHaveBeenCalledWith('', { types: ['user'], limit: 25 }))
        expect(adminUserService.listUsers).not.toHaveBeenCalled()
        // Stewards add people, not groups.
        expect(screen.queryByRole('button', { name: 'Group' })).not.toBeInTheDocument()

        await user.click(await screen.findByRole('button', { name: /Ana T/ }))
        await user.click(screen.getByRole('button', { name: 'Add to workspace' }))
        await waitFor(() => expect(members.create).toHaveBeenCalledWith('ws_fin', {
            subjectType: 'user', subjectId: 'usr_ana', role: 'workspace_member', expiresIn: null, exception: undefined,
        }, { reason: undefined }))
    })

    it('leaves exceptions to the admins where the identity provider decides', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue({ ...STEWARD_OPTIONS, accessMode: 'idp' })
        renderTab(false)
        await user.click(await screen.findByRole('button', { name: 'Add member' }))
        await user.click(await screen.findByRole('button', { name: /Ana T/ }))

        expect(screen.getByRole('button', { name: 'Add to workspace' })).toBeDisabled()
        expect(screen.queryByRole('checkbox', { name: /Add them here as an exception/ })).not.toBeInTheDocument()
        expect(screen.getByText(/only the workspace’s admins can add someone here as an exception/)).toBeInTheDocument()
        expect(members.create).not.toHaveBeenCalled()
    })
})
