/**
 * Administration → Service accounts: each account with how it stands — no
 * manager left and when its keys pause, or one person it depends on — each
 * opening on its own page, and creating one, which takes a name and at least
 * one manager, a person or a team (whose members may then act as it, which
 * the page says).
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { inDays } from '@/components/apiKeys/__tests__/fixtures'
import type { ServiceAccount, ServiceAccountDetail } from '@/services/serviceAccountService'

const { sa, searchDirectory, notify } = vi.hoisted(() => ({
    sa: { list: vi.fn(), create: vi.fn(), handOver: vi.fn() },
    searchDirectory: vi.fn(),
    notify: vi.fn(),
}))

vi.mock('@/services/serviceAccountService', () => ({ serviceAccountService: sa }))
vi.mock('@/services/userDirectoryService', () => ({ searchDirectory }))
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
        singleManager: true, unmanagedSince: null, pausesAt: null, adminHold: false, handOver: null, ...over,
    }
}

function detail(over: Partial<ServiceAccountDetail> = {}): ServiceAccountDetail {
    return {
        ...account(), roles: [], requests: [], liveKeys: 2,
        can: { view: true, edit: true, disable: true, enable: true, managers: true, keys: false, grant: true, revoke: true, request: true },
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
