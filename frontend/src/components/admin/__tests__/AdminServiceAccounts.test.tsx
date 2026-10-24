/**
 * Administration → Service accounts: each account with how it stands — no
 * manager left and when its keys pause, or one person it depends on — and
 * creating one, which takes a name and at least one manager, a person or a
 * team (whose members may then act as it, which the page says).
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { inDays } from '@/components/apiKeys/__tests__/fixtures'
import type { ServiceAccount, ServiceAccountDetail } from '@/services/serviceAccountService'

const { sa, searchDirectory, can, notify } = vi.hoisted(() => ({
    sa: {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), disable: vi.fn(), enable: vi.fn(),
        addManager: vi.fn(), removeManager: vi.fn(), grantRole: vi.fn(), revokeRole: vi.fn(), handOver: vi.fn(),
    },
    searchDirectory: vi.fn(),
    can: { mintAny: false },
    notify: vi.fn(),
}))

vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: sa }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: () => Promise.resolve([]) } }))
vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => (perm === 'system:users:manage' ? can.mintAny : true),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { AdminServiceAccounts } from '../AdminServiceAccounts'

const ADA = {
    type: 'user' as const, id: 'usr_ada', name: 'Ada Lovelace', email: 'ada@example.com', inGoodStanding: true,
    membersInGoodStanding: null, addedAt: '2026-10-01T00:00:00+00:00', addedBy: null,
}

function account(over: Partial<ServiceAccount> = {}): ServiceAccount {
    return {
        id: 'svc_sync', name: 'Metadata sync', description: null, status: 'active',
        createdAt: '2026-10-01T00:00:00+00:00', createdBy: null, managers: [ADA], managed: true,
        singleManager: true, unmanagedSince: null, pausesAt: null, handOver: null, ...over,
    }
}

function detail(over: Partial<ServiceAccountDetail> = {}): ServiceAccountDetail {
    return { ...account(), roles: [], liveKeys: 2, ...over }
}

beforeEach(() => {
    vi.clearAllMocks()
    can.mintAny = false
    sa.list.mockResolvedValue({
        items: [
            account(),
            account({ id: 'svc_old', name: 'Old export', managers: [], managed: false, singleManager: false, pausesAt: inDays(4) }),
            account({ id: 'svc_off', name: 'Retired job', status: 'disabled', singleManager: false }),
        ],
        total: 3, graceDays: 14,
    })
    sa.get.mockResolvedValue(detail())
    searchDirectory.mockResolvedValue({ users: [], groups: [{ id: 'grp_data', name: 'Data platform', memberCount: 4 }] })
})

describe('the list', () => {
    it('says how each account stands, and how long keys outlive a last manager', async () => {
        render(<AdminServiceAccounts />)
        const rows = await screen.findByRole('list', { name: 'Service accounts' })
        expect(within(rows).getByText('Metadata sync').closest('li')).toHaveTextContent('Single manager')
        expect(within(rows).getByText('Old export').closest('li')).toHaveTextContent(/needs a manager — keys pause/i)
        expect(within(rows).getByText('Retired job').closest('li')).toHaveTextContent('Disabled')
        expect(screen.getByText(/keep working for 14 days after its last manager goes/i)).toBeInTheDocument()
    })
})

describe('creating one', () => {
    it('takes a name and a manager, says what a team as manager means, and opens the new account', async () => {
        sa.create.mockResolvedValue(detail({ id: 'svc_new', name: 'Nightly export' }))
        sa.get.mockResolvedValue(detail({ id: 'svc_new', name: 'Nightly export' }))
        render(<AdminServiceAccounts />)
        await userEvent.click(await screen.findByRole('button', { name: /create service account/i }))
        const dialog = await screen.findByRole('dialog', { name: 'Create a service account' })
        const create = within(dialog).getByRole('button', { name: /^create$/i })
        await userEvent.type(within(dialog).getByLabelText('Name'), 'Nightly export')
        expect(create).toBeDisabled()                                      // no manager yet

        await userEvent.type(within(dialog).getByLabelText('Add a person or a team'), 'data')
        await userEvent.click(await within(dialog).findByRole('button', { name: /data platform/i }))
        expect(within(dialog).getByText(/anyone in data platform can make keys that act as “nightly export”/i)).toBeInTheDocument()
        await userEvent.click(create)

        await waitFor(() => expect(sa.create).toHaveBeenCalledWith({
            name: 'Nightly export', description: undefined, managers: [{ type: 'group', id: 'grp_data' }],
        }))
        expect(await screen.findByRole('dialog', { name: 'Nightly export' })).toBeInTheDocument()
    })
})

describe('one account', () => {
    it('opens straight onto the account a link names', async () => {
        window.history.pushState({}, '', '/admin/service-accounts?account=svc_sync')
        try {
            render(<AdminServiceAccounts />)
            expect(await screen.findByRole('dialog', { name: 'Metadata sync' })).toBeInTheDocument()
            expect(sa.get).toHaveBeenCalledWith('svc_sync')
        } finally {
            window.history.pushState({}, '', '/')
        }
    })

    it('asks before removing its last manager', async () => {
        sa.removeManager.mockResolvedValue(detail({ managers: [], managed: false, singleManager: false }))
        render(<AdminServiceAccounts />)
        await userEvent.click(await screen.findByText('Metadata sync'))
        const dialog = await screen.findByRole('dialog', { name: 'Metadata sync' })
        await userEvent.click(await within(dialog).findByRole('button', { name: 'Stop Ada Lovelace managing it' }))
        expect(sa.removeManager).not.toHaveBeenCalled()
        expect(within(dialog).getByText(/that is its last manager/i)).toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Ada Lovelace, the last manager?' }))
        await waitFor(() => expect(sa.removeManager).toHaveBeenCalledWith('svc_sync', ADA))
    })

    it('links to making its keys only for those who may make any account’s', async () => {
        render(<AdminServiceAccounts />)
        await userEvent.click(await screen.findByText('Metadata sync'))
        const dialog = await screen.findByRole('dialog', { name: 'Metadata sync' })
        expect(await within(dialog).findByRole('link', { name: /see them/i })).toHaveAttribute('href', '/admin/api-keys?ownerId=svc_sync')
        expect(within(dialog).queryByRole('link', { name: /make or revoke its keys/i })).not.toBeInTheDocument()
    })

    it('stops every key at once when disabled', async () => {
        sa.disable.mockResolvedValue(detail({ status: 'disabled' }))
        render(<AdminServiceAccounts />)
        await userEvent.click(await screen.findByText('Metadata sync'))
        const dialog = await screen.findByRole('dialog', { name: 'Metadata sync' })
        await userEvent.click(await within(dialog).findByRole('button', { name: /^disable$/i }))
        await waitFor(() => expect(sa.disable).toHaveBeenCalledWith('svc_sync'))
        expect(await within(dialog).findByRole('button', { name: /^enable$/i })).toBeInTheDocument()
    })
})
