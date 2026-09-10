/**
 * The user table stops keeping its own two banners.
 *
 * AdminUsers was a third variant again: a green success banner in the normal
 * page flow (so the toolbar jumped down whenever it appeared) with its own
 * 4000 ms timer, and a red one that never auto-dismissed at all. Both of them
 * sat behind every modal on the page, which is where the two validation
 * messages — "password must be at least 8 characters", "first and last name
 * are required" — were being rendered while the modal that asked for them
 * covered them up.
 *
 * They speak through the app's one notification stack now. What stays inline is
 * the one thing that is still TRUE while it is read: the list failed to load.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listUsers: vi.fn(),
        approveUser: vi.fn(),
        suspendUser: vi.fn(),
        reactivateUser: vi.fn(),
        changeRole: vi.fn(),
        updateUser: vi.fn(),
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
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import { useNotificationStore } from '@/components/ui/notifications'

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

const raised = () => useNotificationStore.getState().notifications
const messages = () => raised().map(n => n.message)

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    vi.mocked(adminUserService.listUsers).mockResolvedValue([user()])
    vi.mocked(adminUserService.approveUser).mockResolvedValue(undefined as never)
    vi.mocked(adminUserService.suspendUser).mockResolvedValue(undefined as never)
    vi.mocked(adminUserService.changeRole).mockResolvedValue(undefined as never)
    vi.mocked(adminUserService.updateUser).mockResolvedValue(undefined as never)
})

describe('AdminUsers — the bespoke banners are gone', () => {
    it('an approval speaks through the one stack, and nothing is added to the page flow', async () => {
        vi.mocked(adminUserService.listUsers).mockResolvedValue([user({ status: 'pending' })])
        const u = userEvent.setup()
        render(<AdminUsers />)
        await u.click(await screen.findByRole('button', { name: /Approve/i }))

        await waitFor(() => expect(messages()).toEqual([
            'Ada Lovelace is approved — they can sign in now.',
        ]))
        // The old green banner lived in the flow above the toolbar and pushed it down.
        expect(screen.queryByText('User approved successfully')).not.toBeInTheDocument()
    })

    it('a suspension names the account and says what it costs them', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await u.click(await screen.findByTitle('Suspend user'))
        // Exact, case-sensitive: the row's own button is "Suspend user".
        await u.click(await screen.findByRole('button', { name: 'Suspend User' }))

        await waitFor(() => expect(messages()).toEqual([
            'Ada Lovelace is suspended — they are signed out and cannot sign back in.',
        ]))
    })

    it('a role change reads as a sentence, not as a role id', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await u.click(await screen.findByTitle('Change organization access'))
        await u.click(await screen.findByText('Org Admin'))
        await u.click(screen.getByRole('button', { name: 'Update Role' }))

        await waitFor(() => expect(messages()).toEqual([
            'Ada Lovelace is now Org Admin.',
        ]))
    })

    it('a failed action is reported, and never as an empty string', async () => {
        vi.mocked(adminUserService.suspendUser).mockRejectedValue(new Error(''))
        const u = userEvent.setup()
        render(<AdminUsers />)
        await u.click(await screen.findByTitle('Suspend user'))
        await u.click(await screen.findByRole('button', { name: 'Suspend User' }))

        await waitFor(() => expect(messages()).toEqual([
            'Could not suspend Ada Lovelace.',
        ]))
        expect(raised()[0].type).toBe('error')
    })
})

describe('AdminUsers — validation the modal used to cover', () => {
    it('says both names are required where the admin can actually see it', async () => {
        const u = userEvent.setup()
        render(<AdminUsers />)
        await u.click(await screen.findByTitle('Edit profile'))
        // The surname, not the first name: an empty first name disables Save,
        // so it is the only one of the two that can reach the check at all.
        await u.clear(await screen.findByPlaceholderText('Last name'))
        await u.click(screen.getByRole('button', { name: 'Save Profile' }))

        await waitFor(() => expect(messages()).toEqual([
            'First and last name are both required.',
        ]))
        expect(adminUserService.updateUser).not.toHaveBeenCalled()
    })
})

describe('AdminUsers — what stays on the page', () => {
    it('a failed load is still described inline: it is true while you read it', async () => {
        vi.mocked(adminUserService.listUsers).mockRejectedValue(new Error('Backend unavailable'))
        render(<AdminUsers />)

        expect(await screen.findByText('Backend unavailable')).toBeInTheDocument()
        expect(messages()).toEqual([])
    })
})
