/**
 * Add member lets a service account in as it lets a person in: found by
 * name, with what it is for and who manages it — a team the identity
 * provider keeps, marked — and given only a role that neither administers
 * the workspace nor lets people in. Where the identity provider decides who
 * is in, only the workspace's admins add one. Removing someone who manages
 * one names it, when its role here gives more than they keep, and removes
 * that role too if asked.
 */
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceMembersService', () => ({
    workspaceMembersService: {
        list: vi.fn(), listEffective: vi.fn(), create: vi.fn(),
        revoke: vi.fn(), previewRevoke: vi.fn(), grantOptions: vi.fn(), serviceAccountCandidates: vi.fn(),
    },
}))
vi.mock('@/services/adminUserService', () => ({ adminUserService: { listUsers: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: { list: vi.fn(), listMembers: vi.fn() } }))
vi.mock('@/services/permissionsService', () => ({ permissionsService: { listRoles: vi.fn() } }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listToAnswer: vi.fn(), approve: vi.fn(), deny: vi.fn(), route: vi.fn() },
}))
vi.mock('@/services/accessReviewsService', () => ({
    accessReviewsService: { list: vi.fn().mockResolvedValue([]) },
}))

import { WorkspaceMembers } from '../WorkspaceMembers'
import { workspaceMembersService, type WorkspaceGrantOptions } from '@/services/workspaceMembersService'
import { adminUserService } from '@/services/adminUserService'
import { accessRequestsService } from '@/services/accessRequestsService'
import { useAuthStore } from '@/store/auth'

function render(ui: ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const OPTIONS: WorkspaceGrantOptions = {
    tier: 'admin', accessMode: 'app', groups: [], idpRoutes: [], dataSources: [],
    roles: [
        { name: 'workspace_admin', description: null, isSystem: true, requestable: false },
        { name: 'workspace_member', description: null, isSystem: true, requestable: true },
        { name: 'workspace_viewer', description: null, isSystem: true, requestable: true },
    ],
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workspaceMembersService.list).mockResolvedValue([])
    vi.mocked(accessRequestsService.listToAnswer).mockResolvedValue([])
    vi.mocked(workspaceMembersService.grantOptions).mockResolvedValue(OPTIONS)
    vi.mocked(adminUserService.listUsers).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(workspaceMembersService.create).mockResolvedValue({} as never)
    vi.mocked(workspaceMembersService.serviceAccountCandidates).mockResolvedValue([{
        id: 'svc_sync', name: 'Metadata sync', description: 'Reads graph metadata nightly',
        managers: [
            { type: 'user', name: 'Ada Lovelace', fromIdp: false },
            { type: 'group', name: 'Data platform', fromIdp: true },
        ],
    }])
    useAuthStore.setState({ permissions: { sid: 's', global: ['system:admin'], ws: {} } } as never)
})

describe('Add member — a service account', () => {
    it('is found with whose it is, and given only a role it may hold', async () => {
        const u = userEvent.setup()
        render(<WorkspaceMembers workspaceId="ws_1" />)
        await u.click(await screen.findByRole('button', { name: 'Add member' }))
        await u.click(await screen.findByRole('button', { name: 'Service account' }))

        await waitFor(() => expect(workspaceMembersService.serviceAccountCandidates).toHaveBeenCalledWith('ws_1', ''))
        const row = await screen.findByRole('button', { name: /Metadata sync/ })
        expect(row).toHaveTextContent(
            'Reads graph metadata nightly · Managed by Ada Lovelace, Data platform (from your identity provider)',
        )
        // Never a role that administers the workspace or lets people in.
        expect(screen.queryByRole('button', { name: /Workspace admin/ })).not.toBeInTheDocument()

        await u.click(row)
        await u.click(screen.getByRole('button', { name: /Workspace viewer/ }))
        await u.click(screen.getByRole('button', { name: 'Add to workspace' }))
        await waitFor(() => expect(workspaceMembersService.create).toHaveBeenCalledWith('ws_1', {
            subjectType: 'user', subjectId: 'svc_sync', role: 'workspace_viewer', expiresIn: null, exception: undefined,
        }, { reason: undefined }))
    })

    it('is not offered to a steward where the identity provider decides who is in', async () => {
        const u = userEvent.setup()
        vi.mocked(workspaceMembersService.grantOptions).mockResolvedValue({ ...OPTIONS, tier: 'steward', accessMode: 'idp' })
        render(<WorkspaceMembers workspaceId="ws_1" canManage={false} />)
        await u.click(await screen.findByRole('button', { name: 'Add member' }))
        expect(await screen.findByText('Choose a user')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Service account' })).not.toBeInTheDocument()
    })
})

describe('Removing someone who manages one', () => {
    const ADA = {
        bindingId: 'bnd_ada', role: 'workspace_member', grantedAt: '2026-01-01T00:00:00Z', grantedBy: null,
        subject: { type: 'user', id: 'usr_ada', displayName: 'Ada Lovelace', secondary: 'ada@x.io' },
    }

    beforeEach(() => {
        vi.mocked(workspaceMembersService.list).mockResolvedValue([ADA] as never)
        vi.mocked(workspaceMembersService.revoke).mockResolvedValue(undefined as never)
        vi.mocked(workspaceMembersService.previewRevoke).mockResolvedValue({
            affectedUsers: 1, affectedWorkspaces: 1, gainedPerms: [], lostPerms: ['workspace:view:read'],
            userImpact: [{ userId: 'usr_ada', displayName: 'Ada Lovelace', email: 'ada@x.io', gained: [], lost: ['workspace:view:read'] }],
            serviceAccounts: [{
                id: 'svc_sync', name: 'Metadata sync', managedBy: ['Ada Lovelace'],
                bindings: [{ bindingId: 'bnd_sync', role: 'workspace_member' }],
            }],
        })
    })

    async function openRemoval() {
        const u = userEvent.setup()
        render(<WorkspaceMembers workspaceId="ws_1" />)
        await u.click(await screen.findByTitle('Revoke binding'))
        const kept = await screen.findByRole('region', { name: 'Service accounts that keep access here' })
        return { u, kept }
    }

    it('names the account they could still act through, and leaves it unless asked', async () => {
        const { u, kept } = await openRemoval()
        expect(kept).toHaveTextContent('Metadata sync')
        expect(kept).toHaveTextContent('Workspace member here · Ada Lovelace manages it')
        await u.click(screen.getByText('Revoke binding', { selector: 'button' }))
        await waitFor(() => expect(workspaceMembersService.revoke).toHaveBeenCalledTimes(1))
        expect(workspaceMembersService.revoke).toHaveBeenCalledWith('ws_1', 'bnd_ada', { reason: undefined })
    })

    it('removes its role too when asked', async () => {
        const { u } = await openRemoval()
        await u.click(screen.getByRole('checkbox', { name: 'Remove its role here too' }))
        await u.click(screen.getByText('Revoke binding', { selector: 'button' }))
        await waitFor(() => expect(workspaceMembersService.revoke).toHaveBeenCalledTimes(2))
        expect(workspaceMembersService.revoke).toHaveBeenNthCalledWith(1, 'ws_1', 'bnd_ada', { reason: undefined })
        expect(workspaceMembersService.revoke).toHaveBeenNthCalledWith(2, 'ws_1', 'bnd_sync', { reason: undefined })
    })
})
