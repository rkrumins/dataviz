/**
 * Joining a name to an id, in both directions.
 *
 * The reported problem was one problem wearing two faces. The audit log
 * showed `usr_ac3f19` under Actor and Target and nothing else, so reading
 * "who changed whose role" meant opening a tab per row. The user list showed
 * names and emails and never the id, so the tab you opened could not be
 * searched by the string you arrived holding. Neither surface could answer a
 * question about the other, and an administrator asked to say which person an
 * event affected had no route from the log to the answer.
 *
 * These pin the round trip: a log row names the person, its details panel
 * hands back the id, and the user list both SHOWS that id and FINDS a user by
 * it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: { listUsers: vi.fn() },
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
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'

const listUsers = vi.mocked(adminUserService.listUsers)

function user(over: Partial<AdminUserResponse> = {}): AdminUserResponse {
    return {
        id: 'usr_ac3f19', email: 'john.doe@example.com',
        firstName: 'John', lastName: 'Doe', displayName: 'John Doe',
        status: 'active', role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resetRequested: false, mustChangePassword: false,
        hasPassword: true, signupSource: 'local_signup', identities: [],
        isSystemAccount: false,
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    listUsers.mockResolvedValue([user()])
    window.history.replaceState({}, '', '/admin/users')
})

describe('/admin/users — the id is on the row', () => {
    it('prints the internal id next to the person it belongs to', async () => {
        // The whole ask: an operator must be able to see that John Doe IS
        // usr_ac3f19, without opening anything.
        render(<AdminUsers />)
        expect(await screen.findByText('John Doe')).toBeInTheDocument()
        expect(screen.getByText('usr_ac3f19')).toBeInTheDocument()
    })

    it('offers the id as something to copy, since every use of one is elsewhere', async () => {
        render(<AdminUsers />)
        expect(await screen.findByRole('button', { name: 'Copy user ID usr_ac3f19' }))
            .toBeInTheDocument()
    })

    it('FINDS a user by the id pasted from a log', async () => {
        // Matching name, email, role and provider but not the identifier made
        // this list unsearchable by the one string that brings people to it.
        listUsers.mockResolvedValue([
            user(),
            user({ id: 'usr_other', email: 'ada@example.com', displayName: 'Ada Lovelace' }),
        ])
        const u = userEvent.setup()
        render(<AdminUsers />)
        await screen.findByText('Ada Lovelace')

        await u.type(
            screen.getByPlaceholderText(/search by name, email, user id, role, or provider/i),
            'usr_ac3f19',
        )
        expect(screen.getByText('John Doe')).toBeInTheDocument()
        expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    })

    it('arrives pre-filtered when the audit log links here with ?q=', async () => {
        // The other half of the round trip: the audit row links to
        // /admin/users?q=<id>, and landing on an unfiltered list of everybody
        // would waste the link.
        window.history.replaceState({}, '', '/admin/users?q=usr_ac3f19')
        listUsers.mockResolvedValue([
            user(),
            user({ id: 'usr_other', email: 'ada@example.com', displayName: 'Ada Lovelace' }),
        ])
        render(<AdminUsers />)
        expect(await screen.findByText('John Doe')).toBeInTheDocument()
        expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    })

    it('renders without a Router, which is how it has always been mounted', async () => {
        // Seeding the search from the URL through `useSearchParams` would make
        // this component unrenderable outside a Router — it reads
        // `window.location` once instead. Two existing test files render it
        // bare, and this states why that must keep working.
        window.history.replaceState({}, '', '/admin/users?q=nope')
        expect(() => render(<AdminUsers />)).not.toThrow()
        await screen.findByPlaceholderText(/search by name/i)
    })
})
