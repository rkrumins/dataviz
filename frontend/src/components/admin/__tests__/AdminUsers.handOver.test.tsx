/**
 * Suspending someone who manages service accounts: the dialog lists them —
 * flagging those nobody else manages, those they manage through a team, and
 * the keys the person made — and offers to hand their seats over to a
 * successor first, so no integration is left with nobody answering for it,
 * and to revoke the keys they made, which they may have kept a copy of.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { list, handOver, adminRevokeMade, searchDirectory, can } = vi.hoisted(() => ({
    list: vi.fn(),
    handOver: vi.fn(),
    adminRevokeMade: vi.fn(),
    searchDirectory: vi.fn(),
    can: { handOver: true, revokeKeys: true },
}))

vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn(), getStats: vi.fn(), suspendUser: vi.fn() },
}))
vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: { list, handOver } }))
vi.mock('@/services/apiKeyService', () => ({ apiKeyService: { adminRevokeMade, adminStats: vi.fn() } }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory }))
vi.mock('@/services/permissionsService', () => ({ permissionsService: { getUserAccess: vi.fn() } }))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => (
        perm === 'system:service-accounts:manage' ? can.handOver
            : perm === 'system:users:manage' ? can.revokeKeys : true
    ),
}))
vi.mock('../AdminInvites', () => ({ AdminInvites: () => null }))
vi.mock('../InviteWizard', () => ({ InviteWizard: () => null }))
vi.mock('../CreateUserWizard', () => ({ CreateUserWizard: () => null }))
vi.mock('@/components/access/AccessSummary', () => ({ AccessSummary: () => null }))

import { AdminUsers } from '../AdminUsers'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import type { ServiceAccount } from '@/services/serviceAccountService'

const ADA: AdminUserResponse = {
    id: 'usr_ada', email: 'ada@example.com',
    firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace',
    status: 'active', role: 'user',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    resetRequested: false, mustChangePassword: false,
    hasPassword: true, signupSource: 'local_signup', identities: [],
    isSystemAccount: false,
}

function account(over: Partial<ServiceAccount>): ServiceAccount {
    return {
        id: 'svc_sync', name: 'Metadata sync', description: null, status: 'active',
        createdAt: '2026-10-01T00:00:00+00:00', createdBy: null, managers: [], managed: true,
        singleManager: true, unmanagedSince: null, pausesAt: null, adminHold: false, deletedAt: null, purgesAt: null,
        handOver: {
            seat: true, teams: [], lastManager: true,
            keysCreatedBy: [{ id: 'apk_1', name: 'nightly', prefix: 'nxsat_Ab', lastUsedAt: null }],
        },
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    can.handOver = true
    can.revokeKeys = true
    window.history.replaceState({}, '', '/admin/users')
    vi.mocked(adminUserService.listUsers).mockResolvedValue({ items: [ADA], total: 1 })
    vi.mocked(adminUserService.getStats).mockResolvedValue({
        total: 1, pending: 0, active: 1, suspended: 0, admins: 0, resetRequested: 0,
    })
    vi.mocked(adminUserService.suspendUser).mockResolvedValue(undefined as never)
    list.mockResolvedValue({
        items: [
            account({}),
            account({ id: 'svc_report', name: 'Reporting', handOver: { seat: true, teams: [], lastManager: false, keysCreatedBy: [] } }),
        ],
        total: 2, graceDays: 14,
    })
    handOver.mockResolvedValue({ handedOver: ['svc_report', 'svc_sync'] })
    adminRevokeMade.mockResolvedValue({ revoked: 1 })
    searchDirectory.mockResolvedValue({ users: [], groups: [{ id: 'grp_data', name: 'Data platform', memberCount: 4 }] })
})

async function suspendDialog() {
    render(<AdminUsers />)
    await userEvent.click(await screen.findByTitle('Suspend user'))
    return screen.findByRole('list', { name: 'Service accounts they manage' })
}

describe('suspending someone who manages service accounts', () => {
    it('lists them, says which nobody else manages, and warns before leaving them stranded', async () => {
        const accounts = await suspendDialog()
        expect(list).toHaveBeenCalledWith({ managedBy: 'usr_ada', limit: 200 })
        expect(within(accounts).getByText('Metadata sync').closest('li')).toHaveTextContent('Only them')
        expect(within(accounts).getByText('Reporting').closest('li')).toHaveTextContent('Others too')
        expect(screen.getByText(/“nightly” for Metadata sync/)).toBeInTheDocument()
        expect(screen.getByText(/leave service accounts nobody manages/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Suspend without handing over' })).toBeInTheDocument()
    })

    it('hands them over to a successor, then suspends', async () => {
        await suspendDialog()
        await userEvent.type(screen.getByLabelText('Hand them over to'), 'data')
        await userEvent.click(await screen.findByRole('button', { name: /data platform/i }))
        await userEvent.click(screen.getByRole('button', { name: 'Hand over and suspend' }))
        await waitFor(() => expect(adminUserService.suspendUser).toHaveBeenCalledWith('usr_ada'))
        expect(handOver).toHaveBeenCalledWith({ fromUserId: 'usr_ada', to: { type: 'group', id: 'grp_data' } })
        expect(handOver.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(adminUserService.suspendUser).mock.invocationCallOrder[0],
        )
    })

    it('revokes the keys they made, then hands over, then suspends', async () => {
        await suspendDialog()
        await userEvent.click(screen.getByRole('checkbox', { name: /revoke the key they made/i }))
        await userEvent.type(screen.getByLabelText('Hand them over to'), 'data')
        await userEvent.click(await screen.findByRole('button', { name: /data platform/i }))
        await userEvent.click(screen.getByRole('button', { name: 'Hand over and suspend' }))
        await waitFor(() => expect(adminUserService.suspendUser).toHaveBeenCalledWith('usr_ada'))
        expect(adminRevokeMade).toHaveBeenCalledWith('usr_ada')
        const order = [adminRevokeMade, handOver, vi.mocked(adminUserService.suspendUser)]
            .map((fn) => fn.mock.invocationCallOrder[0])
        expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    it('leaves the keys alone unless asked', async () => {
        await suspendDialog()
        await userEvent.click(screen.getByRole('button', { name: 'Suspend without handing over' }))
        await waitFor(() => expect(adminUserService.suspendUser).toHaveBeenCalledWith('usr_ada'))
        expect(adminRevokeMade).not.toHaveBeenCalled()
        expect(handOver).not.toHaveBeenCalled()
    })

    it('says to rotate them where revoking is not theirs to do', async () => {
        can.revokeKeys = false
        await suspendDialog()
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
        expect(screen.getByText(/rotate it once they have gone/)).toBeInTheDocument()
    })

    it('lists what they manage through a team and the keys they made elsewhere, and hands over only their seats', async () => {
        list.mockResolvedValue({
            items: [
                account({ id: 'svc_team', name: 'Through the team', handOver: { seat: false, teams: ['Data team'], lastManager: true, keysCreatedBy: [] } }),
                account({
                    id: 'svc_made', name: 'Made elsewhere',
                    handOver: { seat: false, teams: [], lastManager: false, keysCreatedBy: [{ id: 'apk_2', name: 'export', prefix: 'nxsat_Cd', lastUsedAt: null }] },
                }),
            ],
            total: 2, graceDays: 14,
        })
        const accounts = await suspendDialog()
        expect(screen.getByText('Ada Lovelace manages 1 service account — nobody else does. They also made keys that still work for 1 more.')).toBeInTheDocument()
        expect(within(accounts).getByText('Through the team').closest('li')).toHaveTextContent('Through Data team')
        expect(within(accounts).getByText('Made elsewhere').closest('li')).toHaveTextContent('Made its keys')
        expect(screen.getByText(/nothing to hand over/)).toBeInTheDocument()
        expect(screen.queryByLabelText('Hand them over to')).not.toBeInTheDocument()
        // Still left with nobody, whoever the successor would have been.
        expect(screen.getByText(/leave service accounts nobody manages/i)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('checkbox', { name: /revoke the key they made/i }))
        await userEvent.click(screen.getByRole('button', { name: 'Suspend User' }))
        await waitFor(() => expect(adminUserService.suspendUser).toHaveBeenCalledWith('usr_ada'))
        expect(adminRevokeMade).toHaveBeenCalledWith('usr_ada')
        expect(handOver).not.toHaveBeenCalled()
    })

    it('says when only some are listed, and still hands over what it cannot list', async () => {
        list.mockResolvedValue({
            items: [account({ id: 'svc_team', name: 'Through the team', handOver: { seat: false, teams: ['Data team'], lastManager: false, keysCreatedBy: [] } })],
            total: 250, graceDays: 14,
        })
        await suspendDialog()
        expect(screen.getByText(/the first 1 of 250 are listed/i)).toBeInTheDocument()
        expect(screen.getByLabelText('Hand them over to')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Suspend without handing over' })).toBeInTheDocument()
    })

    it('says so when their service accounts cannot be read', async () => {
        list.mockRejectedValue(new Error('The service could not be reached.'))
        render(<AdminUsers />)
        await userEvent.click(await screen.findByTitle('Suspend user'))
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'The service could not be reached. Suspending them may leave service accounts nobody manages.',
        )
    })

    it('is not asked of an administrator who does not look after service accounts', async () => {
        can.handOver = false
        render(<AdminUsers />)
        await userEvent.click(await screen.findByTitle('Suspend user'))
        expect(await screen.findByRole('button', { name: 'Suspend User' })).toBeInTheDocument()
        expect(list).not.toHaveBeenCalled()
    })
})
