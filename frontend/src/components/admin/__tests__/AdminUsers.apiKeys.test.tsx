/**
 * A person's API keys from their record: "API keys — n active · View" in the
 * access drawer's Activity block, linking to the inventory filtered to them.
 * Only for those who may read the inventory, and silent when the count
 * cannot be had — the rest of the drawer does not depend on it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { adminStats, can } = vi.hoisted(() => ({
    adminStats: vi.fn(),
    can: { auditRead: true },
}))

vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn(), getStats: vi.fn() },
}))
vi.mock('@/services/permissionsService', () => ({
    permissionsService: { getUserAccess: vi.fn() },
}))
vi.mock('@/services/apiKeyService', () => ({ apiKeyService: { adminStats } }))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => (perm === 'system:audit:read' ? can.auditRead : true),
}))
vi.mock('../AdminInvites', () => ({ AdminInvites: () => null }))
vi.mock('../InviteWizard', () => ({ InviteWizard: () => null }))
vi.mock('../CreateUserWizard', () => ({ CreateUserWizard: () => null }))
vi.mock('@/components/access/AccessSummary', () => ({ AccessSummary: () => null }))

import { AdminUsers } from '../AdminUsers'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'

const ADA: AdminUserResponse = {
    id: 'usr_1', email: 'ada@example.com',
    firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace',
    status: 'active', role: 'user',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    resetRequested: false, mustChangePassword: false,
    hasPassword: true, signupSource: 'local_signup', identities: [],
    isSystemAccount: false,
}

const STATS = {
    total: 3, byStatus: { active: 2, paused: 0, ownerInactive: 0, expired: 1, revoked: 0 },
    expiringSoon: 0, neverExpires: 0, unused90: 0, revoked30d: 0,
}

beforeEach(() => {
    vi.clearAllMocks()
    can.auditRead = true
    window.history.replaceState({}, '', '/admin/users')
    vi.mocked(adminUserService.listUsers).mockResolvedValue({ items: [ADA], total: 1 })
    vi.mocked(adminUserService.getStats).mockResolvedValue({
        total: 1, pending: 0, active: 1, suspended: 0, admins: 0, resetRequested: 0,
    })
    adminStats.mockResolvedValue(STATS)
})

async function openDrawer() {
    render(<AdminUsers />)
    await userEvent.click(await screen.findByText('Ada Lovelace'))
    return screen.findByRole('complementary')
}

describe('their API keys, from their record', () => {
    it('counts the live ones and links to them', async () => {
        const drawer = await openDrawer()
        const fact = (await within(drawer).findByText('API keys')).nextElementSibling as HTMLElement
        expect(fact).toHaveTextContent(/^2 active · View$/)
        expect(within(fact).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/admin/api-keys?ownerId=usr_1')
        expect(adminStats).toHaveBeenCalledWith({ ownerId: 'usr_1' })
    })

    it('says nothing when the count cannot be had', async () => {
        adminStats.mockRejectedValue(new Error('403'))
        const drawer = await openDrawer()
        await waitFor(() => expect(adminStats).toHaveBeenCalled())
        expect(within(drawer).getByText('Joined')).toBeInTheDocument()
        expect(within(drawer).queryByText('API keys')).not.toBeInTheDocument()
    })

    it('is not asked for without the right to read the inventory', async () => {
        can.auditRead = false
        const drawer = await openDrawer()
        expect(within(drawer).getByText('Joined')).toBeInTheDocument()
        expect(within(drawer).queryByText('API keys')).not.toBeInTheDocument()
        expect(adminStats).not.toHaveBeenCalled()
    })
})
