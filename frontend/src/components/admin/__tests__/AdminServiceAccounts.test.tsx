/**
 * Administration → Service accounts: each account with how it stands — no
 * manager left and when its keys pause, or one person it depends on — each
 * opening on its own page, and creating one, which takes a name and at least
 * one manager, a person or a team (whose members may then act as it, which
 * the page says). The list narrows by standing, manager and workspace, and
 * Deleted lists those that can still be restored.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { inDays } from '@/components/apiKeys/__tests__/fixtures'
import type { ServiceAccount, ServiceAccountDetail } from '@/services/serviceAccountService'

const { sa, searchDirectory, notify, listPage } = vi.hoisted(() => ({
    sa: { list: vi.fn(), create: vi.fn(), handOver: vi.fn() },
    searchDirectory: vi.fn(),
    notify: vi.fn(),
    listPage: vi.fn(),
}))

vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: sa }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { listPage } }))
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
        singleManager: true, unmanagedSince: null, pausesAt: null, adminHold: false, deletedAt: null, purgesAt: null,
        handOver: null, ...over,
    }
}

function detail(over: Partial<ServiceAccountDetail> = {}): ServiceAccountDetail {
    return {
        ...account(), roles: [], requests: [], liveKeys: 2,
        can: {
            view: true, edit: true, disable: true, enable: true, managers: true, keys: false, grant: true, revoke: true,
            request: true, delete: true, restore: false,
        },
        ...over,
    }
}

const realLocation = window.location
const assign = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } })
    sa.list.mockResolvedValue({
        items: [
            account(),
            account({ id: 'svc_old', name: 'Old export', managers: [], managed: false, singleManager: false, pausesAt: inDays(4) }),
            account({ id: 'svc_off', name: 'Retired job', status: 'disabled', singleManager: false }),
        ],
        total: 3, graceDays: 14,
    })
    searchDirectory.mockResolvedValue({ users: [], groups: [{ id: 'grp_data', name: 'Data platform', memberCount: 4 }] })
    listPage.mockResolvedValue({ items: [{ id: 'ws_sales', name: 'Sales' }], totalCount: 1 })
})

afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
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

    it('opens each account on its own page', async () => {
        render(<AdminServiceAccounts />)
        const rows = await screen.findByRole('list', { name: 'Service accounts' })
        expect(within(rows).getByText('Metadata sync').closest('a')).toHaveAttribute('href', '/service-accounts/svc_sync')
    })
})

describe('narrowing it', () => {
    /** The filters the latest list was read with. */
    const lastAsked = () => sa.list.mock.calls[sa.list.mock.calls.length - 1][0]

    it('by standing, by who manages them, and by the workspace they have a role in', async () => {
        render(<AdminServiceAccounts />)
        await screen.findByRole('list', { name: 'Service accounts' })
        await userEvent.selectOptions(screen.getByLabelText('Standing'), 'Needs a manager')
        await waitFor(() => expect(lastAsked()).toMatchObject({ standing: 'unmanaged' }))

        await userEvent.click(screen.getByRole('button', { name: /managed by…/i }))
        await userEvent.type(screen.getByLabelText(/^managed by — /i), 'data')
        await userEvent.click(await screen.findByRole('button', { name: /data platform/i }))
        await waitFor(() => expect(lastAsked()).toMatchObject({ standing: 'unmanaged', manager: 'grp_data' }))
        expect(screen.getByText('Managed by Data platform')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: /in a workspace…/i }))
        await userEvent.click(await screen.findByRole('button', { name: 'Sales' }))
        await waitFor(() => expect(lastAsked()).toMatchObject({ manager: 'grp_data', workspace: 'ws_sales' }))

        await userEvent.click(screen.getByRole('button', { name: /stop showing only those managed by data platform/i }))
        await waitFor(() => expect(lastAsked()).toMatchObject({ manager: undefined, workspace: 'ws_sales' }))
    })

    it('lists the deleted accounts that can still be restored, and until when', async () => {
        render(<AdminServiceAccounts />)
        await screen.findByRole('list', { name: 'Service accounts' })
        sa.list.mockResolvedValue({
            items: [account({ deletedAt: inDays(-2), purgesAt: inDays(28) })], total: 1, graceDays: 14,
        })
        await userEvent.click(screen.getByRole('tab', { name: 'Deleted' }))
        await waitFor(() => expect(lastAsked()).toMatchObject({ status: 'deleted' }))
        const rows = await screen.findByRole('list', { name: 'Service accounts' })
        const row = within(rows).getByText('Metadata sync').closest('li')
        expect(row).toHaveTextContent('Deleted')
        expect(row).toHaveTextContent(/restore by /i)
    })

    it('says deleted accounts wait there for 30 days when there are none', async () => {
        render(<AdminServiceAccounts />)
        await screen.findByRole('list', { name: 'Service accounts' })
        sa.list.mockResolvedValue({ items: [], total: 0, graceDays: 14 })
        await userEvent.click(screen.getByRole('tab', { name: 'Deleted' }))
        expect(await screen.findByText('Nothing deleted lately')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument()
    })
})

describe('creating one', () => {
    it('takes a name and a manager, says what a team as manager means, and opens the new account', async () => {
        sa.create.mockResolvedValue(detail({ id: 'svc_new', name: 'Nightly export' }))
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
        await waitFor(() => expect(assign).toHaveBeenCalledWith('/service-accounts/svc_new'))
    })
})
