/**
 * The user table pages, searches and counts on the SERVER.
 *
 * It used to fetch one page — the endpoint's default fifty — and search,
 * sort, count and paginate that in the browser. With 80 accounts the 30
 * oldest could be neither seen nor found, and every KPI said 50. These pin
 * the table asking for exactly the slice on screen, and taking its totals
 * from the server rather than from whichever rows it happens to hold.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listUsers: vi.fn(),
        getStats: vi.fn(),
        approveUser: vi.fn(),
    },
}))
vi.mock('@/services/permissionsService', () => ({
    permissionsService: { getUserAccess: vi.fn() },
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('../AdminInvites', () => ({ AdminInvites: () => null }))
vi.mock('../InviteWizard', () => ({ InviteWizard: () => null }))
vi.mock('../CreateUserWizard', () => ({ CreateUserWizard: () => null }))
vi.mock('@/components/access/AccessSummary', () => ({ AccessSummary: () => null }))

import { AdminUsers } from '../AdminUsers'
import {
    adminUserService,
    type AdminUserResponse,
    type ListUsersParams,
} from '@/services/adminUserService'

const listUsers = vi.mocked(adminUserService.listUsers)
const getStats = vi.mocked(adminUserService.getStats)

function user(i: number, over: Partial<AdminUserResponse> = {}): AdminUserResponse {
    return {
        id: `usr_${i}`, email: `person${i}@example.com`,
        firstName: 'Person', lastName: String(i), displayName: `Person ${i}`,
        status: 'active', role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resetRequested: false, mustChangePassword: false,
        hasPassword: true, signupSource: 'local_signup', identities: [],
        isSystemAccount: false,
        ...over,
    }
}

/** A server holding `total` accounts, answering one 25-row slice at a time. */
function serve(total: number) {
    listUsers.mockImplementation(async ({ offset = 0, limit }: ListUsersParams) => ({
        items: Array.from(
            { length: Math.max(0, Math.min(limit, total - offset)) },
            (_, i) => user(offset + i),
        ),
        total,
    }))
}

const lastCall = () => listUsers.mock.lastCall?.[0]

beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/admin/users')
    serve(81)
    getStats.mockResolvedValue({
        total: 81, pending: 4, active: 70, suspended: 7, admins: 3, resetRequested: 2,
    })
})

describe('AdminUsers — the server does the paging', () => {
    it('asks for one page, and pages on through all 81 accounts', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)

        expect(await screen.findByText('Person 0')).toBeInTheDocument()
        expect(listUsers).toHaveBeenCalledWith(expect.objectContaining({
            limit: 25, offset: 0, sort: 'createdAt', order: 'desc',
        }))
        expect(screen.getByText('Page 1 / 4')).toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Next page' }))
        expect(await screen.findByText('Person 25')).toBeInTheDocument()
        expect(lastCall()).toMatchObject({ offset: 25 })
        expect(screen.queryByText('Person 0')).not.toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Next page' }))
        await u.click(screen.getByRole('button', { name: 'Next page' }))
        // The last page — accounts 76 to 81, the ones a 50-row cap never showed.
        expect(await screen.findByText('Person 80')).toBeInTheDocument()
        expect(screen.getByText('Page 4 / 4')).toBeInTheDocument()
    })

    it('sends the search to the server once typing settles, from the first page', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await screen.findByText('Person 0')
        await u.click(screen.getByRole('button', { name: 'Next page' }))
        await waitFor(() => expect(lastCall()).toMatchObject({ offset: 25 }))

        await u.type(
            screen.getByPlaceholderText(/search by name, email, user id, role, or provider/i),
            'ada',
        )
        await waitFor(() => expect(lastCall()).toMatchObject({ search: 'ada', offset: 0 }))
        // Debounced: one request for the settled term, none per keystroke.
        const searched = listUsers.mock.calls.map(([p]) => p.search)
        expect(searched).not.toContain('a')
        expect(searched).not.toContain('ad')
    })

    it('a status tab and a column header are server requests too', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await screen.findByText('Person 0')

        await u.click(screen.getByRole('button', { name: /^Pending/ }))
        await waitFor(() => expect(lastCall()).toMatchObject({ status: 'pending', offset: 0 }))

        await u.click(screen.getByRole('button', { name: 'User' }))
        await waitFor(() => expect(lastCall()).toMatchObject({
            status: 'pending', sort: 'name', order: 'asc',
        }))
    })
})

describe('AdminUsers — counts describe everyone, not the page', () => {
    it('cards, tab badges and banners come from the server totals', async () => {
        render(<AdminUsers />)
        await screen.findByText('Person 0')

        // 25 rows on screen; every number below is about all 81 accounts.
        await waitFor(() =>
            expect(screen.getByText('Total Users').previousElementSibling).toHaveTextContent('81'))
        expect(screen.getByText('Administrators').previousElementSibling).toHaveTextContent('3')
        expect(screen.getByText('4 users awaiting approval')).toBeInTheDocument()
        expect(screen.getByText('2 password reset requests')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^Suspended/ })).toHaveTextContent('7')
    })

    it('an approval refreshes the counts as well as the rows', async () => {
        listUsers.mockResolvedValue({ items: [user(1, { status: 'pending' })], total: 1 })
        vi.mocked(adminUserService.approveUser).mockResolvedValue({ detail: 'ok' })
        const u = userEvent.setup()
        render(<AdminUsers />)

        await u.click(await screen.findByRole('button', { name: 'Approve' }))
        await waitFor(() => expect(getStats).toHaveBeenCalledTimes(2))
        expect(listUsers).toHaveBeenCalledTimes(2)
    })
})

describe('AdminUsers — the page on screen is always the newest answer', () => {
    it('a slow, superseded response never paints over a newer one', async () => {
        const pending: Array<{ offset: number; resolve: (v: { items: AdminUserResponse[]; total: number }) => void }> = []
        listUsers.mockImplementation(({ offset = 0 }) =>
            new Promise(resolve => { pending.push({ offset, resolve }) }))
        const u = userEvent.setup()
        render(<AdminUsers />)

        await waitFor(() => expect(pending).toHaveLength(1))
        await act(async () => pending[0].resolve({ items: [user(0)], total: 81 }))
        await screen.findByText('Person 0')

        // Page 2, then page 3 — and page 3's answer arrives first.
        await u.click(screen.getByRole('button', { name: 'Next page' }))
        await u.click(screen.getByRole('button', { name: 'Next page' }))
        await waitFor(() => expect(pending.map(p => p.offset)).toEqual([0, 25, 50]))
        await act(async () => pending[2].resolve({ items: [user(50)], total: 81 }))
        expect(await screen.findByText('Person 50')).toBeInTheDocument()

        await act(async () => pending[1].resolve({ items: [user(25)], total: 81 }))
        expect(screen.queryByText('Person 25')).not.toBeInTheDocument()
        expect(screen.getByText('Person 50')).toBeInTheDocument()
    })

    it('steps back to the new last page when its own page empties', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await screen.findByText('Person 0')
        for (let i = 0; i < 3; i++) {
            await u.click(screen.getByRole('button', { name: 'Next page' }))
        }
        expect(await screen.findByText('Person 80')).toBeInTheDocument()

        // Six accounts left the list elsewhere; page 4 no longer exists.
        serve(75)
        await u.click(screen.getByRole('button', { name: /Refresh/ }))
        await waitFor(() => expect(lastCall()).toMatchObject({ offset: 50 }))
        expect(await screen.findByText('Person 50')).toBeInTheDocument()
        expect(screen.getByText('Page 3 / 3')).toBeInTheDocument()
    })
})
