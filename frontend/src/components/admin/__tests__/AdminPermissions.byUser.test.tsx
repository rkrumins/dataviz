/**
 * Permissions → By user reaches every account.
 *
 * The picker loaded the admin user list once — whose default page is fifty —
 * and searched that in the browser, so nobody past the first fifty could be
 * inspected. It now asks the server for each page of matches.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn() },
}))
vi.mock('@/services/permissionsService', () => ({
    permissionsService: {
        listPermissions: vi.fn(), listRoles: vi.fn(), getUserAccess: vi.fn(),
    },
}))
vi.mock('../RBACSearchBar', () => ({ RBACSearchBar: () => null }))
vi.mock('@/components/access/AccessSummary', () => ({ AccessSummary: () => null }))

import { AdminPermissions } from '../AdminPermissions'
import {
    adminUserService,
    type AdminUserResponse,
    type ListUsersParams,
} from '@/services/adminUserService'
import { permissionsService } from '@/services/permissionsService'

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
    vi.mocked(permissionsService.listPermissions).mockResolvedValue([])
    vi.mocked(permissionsService.listRoles).mockResolvedValue([])
    // 60 accounts on the server, 25 to a page.
    listUsers.mockImplementation(async ({ offset = 0, limit }: ListUsersParams) => ({
        items: Array.from({ length: Math.max(0, Math.min(limit, 60 - offset)) }, (_, i) => person(offset + i)),
        total: 60,
    }))
})

describe('Permissions → By user', () => {
    it('searches and pages every account on the server', async () => {
        const u = userEvent.setup()
        render(<MemoryRouter><AdminPermissions /></MemoryRouter>)
        await u.click(await screen.findByRole('button', { name: /By user/ }))

        await waitFor(() => expect(listUsers).toHaveBeenCalledWith({
            search: '', sort: 'name', order: 'asc', limit: 25, offset: 0,
        }))
        expect(await screen.findByText('Person 24')).toBeInTheDocument()
        expect(screen.getByText('Page 1 / 3')).toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Next page' }))
        expect(await screen.findByText('Person 49')).toBeInTheDocument()
        expect(lastCall()).toMatchObject({ offset: 25 })

        await u.type(screen.getByPlaceholderText('Search users...'), 'ada')
        await waitFor(() => expect(lastCall()).toMatchObject({ search: 'ada', offset: 0 }))
    })
})
