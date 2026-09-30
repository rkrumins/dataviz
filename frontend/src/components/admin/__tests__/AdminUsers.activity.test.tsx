/**
 * Last seen, and the drawer's Activity block.
 *
 * The table said when an account joined and nothing about whether anybody
 * still uses it. These pin the Last seen column (relative, with the exact
 * instant on hover, "Not yet" when the server has nothing), its header
 * asking the SERVER to sort, and the drawer listing Joined / Last signed
 * in / Last seen / Last activity — "Not yet" for whichever is missing.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listUsers: vi.fn(),
        getStats: vi.fn(),
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
vi.mock('@/components/access/AccessSummary', () => ({
    AccessSummary: () => null,
}))

import { AdminUsers } from '../AdminUsers'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import { formatUtc } from '@/lib/timeAgo'

const listUsers = vi.mocked(adminUserService.listUsers)

function user(over: Partial<AdminUserResponse> = {}): AdminUserResponse {
    return {
        id: 'usr_1', email: 'ada@example.com',
        firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace',
        status: 'active', role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resetRequested: false, mustChangePassword: false,
        hasPassword: true, signupSource: 'local_signup', identities: [],
        isSystemAccount: false,
        ...over,
    }
}

/** One server page holding exactly these rows. */
const page = (...items: AdminUserResponse[]) => ({ items, total: items.length })

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

/** The value cell beside a drawer label. */
const fact = (drawer: HTMLElement, label: string) =>
    within(drawer).getByText(label).nextElementSibling as HTMLElement

beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/admin/users')
    listUsers.mockResolvedValue(page(user()))
    vi.mocked(adminUserService.getStats).mockResolvedValue({
        total: 1, pending: 0, active: 1, suspended: 0, admins: 0, resetRequested: 0,
    })
})

describe('the Last seen column', () => {
    it('reads relative, with the exact instant on hover, and "Not yet" for nobody', async () => {
        const seen = hoursAgo(2)
        listUsers.mockResolvedValue(page(
            user({ lastSeenAt: seen }),
            user({ id: 'usr_2', email: 'bo@example.com', displayName: 'Bo Never', lastSeenAt: null }),
        ))
        render(<AdminUsers />)

        const relative = await screen.findByText('2h ago')
        expect(relative).toHaveAttribute('title', formatUtc(seen))
        const never = screen.getByText('Bo Never').closest('tr') as HTMLElement
        expect(within(never).getByText('Not yet')).toBeInTheDocument()
    })

    it('an older server that sends no field at all reads "Not yet" too', async () => {
        render(<AdminUsers />)
        const row = (await screen.findByText('Ada Lovelace')).closest('tr') as HTMLElement
        expect(within(row).getByText('Not yet')).toBeInTheDocument()
    })

    it('its header asks the server to sort by it', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await screen.findByText('Ada Lovelace')

        await u.click(screen.getByRole('button', { name: 'Last seen' }))
        await waitFor(() => expect(listUsers.mock.lastCall?.[0]).toMatchObject({
            sort: 'lastSeenAt', order: 'asc', offset: 0,
        }))
    })
})

describe('the drawer\'s Activity block', () => {
    it('lists all four, "Not yet" for whichever is missing', async () => {
        const joined = hoursAgo(24 * 40)
        const signedIn = hoursAgo(3)
        listUsers.mockResolvedValue(page(user({
            createdAt: joined, lastLoginAt: signedIn, lastSeenAt: null,
        })))
        const u = userEvent.setup()
        render(<AdminUsers />)

        await u.click(await screen.findByText('Ada Lovelace'))
        const drawer = await screen.findByRole('complementary')
        expect(within(drawer).getByText('Activity')).toBeInTheDocument()

        expect(fact(drawer, 'Joined')).toHaveTextContent(`${formatUtc(joined)} · 1mo ago`)
        expect(fact(drawer, 'Last signed in')).toHaveTextContent(`${formatUtc(signedIn)} · 3h ago`)
        expect(fact(drawer, 'Last seen')).toHaveTextContent(/^Not yet$/)
        // Absent (an older server), not just null.
        expect(fact(drawer, 'Last activity')).toHaveTextContent(/^Not yet$/)
    })

    it('an audit-log deep link opens the same drawer, Activity and all', async () => {
        window.history.replaceState({}, '', '/admin/users?user=usr_1')
        const active = hoursAgo(1)
        listUsers.mockResolvedValue(page(user({ lastActiveAt: active })))
        render(<AdminUsers />)

        const drawer = await screen.findByRole('complementary')
        expect(fact(drawer, 'Last activity')).toHaveTextContent(`${formatUtc(active)} · 1h ago`)
    })
})
