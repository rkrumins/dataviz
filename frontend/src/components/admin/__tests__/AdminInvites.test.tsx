import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listInvites: vi.fn(),
        revokeInvite: vi.fn(),
        listInviteRedemptions: vi.fn(),
        extendInvite: vi.fn(),
        regenerateInvite: vi.fn(),
    },
}))

import { AdminInvites } from '../AdminInvites'
import { adminUserService, type InviteSummary } from '@/services/adminUserService'

const HOUR = 1000 * 60 * 60

function invite(over: Partial<InviteSummary> = {}): InviteSummary {
    return {
        id: 'inv_abc123',
        role: 'workspace_member',
        workspaceId: 'ws_1',
        workspaceName: 'Finance',
        email: null,
        emailDomain: null,
        groupIds: [],
        groupNames: [],
        maxUses: null,
        useCount: 0,
        redemptionCount: 0,
        status: 'active',
        createdBy: 'usr_admin',
        createdAt: new Date(Date.now() - HOUR).toISOString(),
        expiresAt: new Date(Date.now() + 72 * HOUR).toISOString(),
        revokedAt: null,
        revokedBy: null,
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminUserService.listInvites).mockResolvedValue([invite()])
})

describe('AdminInvites', () => {
    it('shows who a shareable link is for and how many have used it', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 3, maxUses: 10 }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText('Anyone with the link')).toBeInTheDocument()
        expect(screen.getByTitle('3 of 10 used · 7 left')).toBeInTheDocument()
        expect(screen.getByText('Finance', { exact: false })).toBeInTheDocument()
    })

    it('names the pinned address for an email-bound link', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ email: 'alice@company.com' }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText('alice@company.com')).toBeInTheDocument()
    })

    it('shows a domain restriction as the audience', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ emailDomain: 'company.com' }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText('@company.com')).toBeInTheDocument()
    })

    it('does not revoke until the confirmation is accepted', async () => {
        // Revoking is instant and irreversible — it kills the link for
        // everyone holding it, including anyone mid-signup. Clicking the
        // button must not be enough on its own.
        render(<AdminInvites />)

        fireEvent.click(await screen.findByTitle('Revoke this link'))

        expect(await screen.findByText(/revoke this invite link\?/i)).toBeInTheDocument()
        expect(adminUserService.revokeInvite).not.toHaveBeenCalled()
    })

    it('names the blast radius in the confirmation', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 4, redemptionCount: 4 }),
        ])
        render(<AdminInvites />)

        fireEvent.click(await screen.findByTitle('Revoke this link'))

        expect(
            await screen.findByText(/4 people have already used it/i),
        ).toBeInTheDocument()
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    })

    it('abandoning the confirmation leaves the link alone', async () => {
        render(<AdminInvites />)
        fireEvent.click(await screen.findByTitle('Revoke this link'))

        fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

        await waitFor(() =>
            expect(screen.queryByText(/revoke this invite link\?/i)).not.toBeInTheDocument(),
        )
        expect(adminUserService.revokeInvite).not.toHaveBeenCalled()
    })

    it('revokes a link and refreshes the list once confirmed', async () => {
        vi.mocked(adminUserService.revokeInvite).mockResolvedValue(
            invite({ status: 'revoked', revokedAt: new Date().toISOString() }),
        )
        render(<AdminInvites />)

        fireEvent.click(await screen.findByTitle('Revoke this link'))
        fireEvent.click(await screen.findByRole('button', { name: /revoke link/i }))

        await waitFor(() =>
            expect(adminUserService.revokeInvite).toHaveBeenCalledWith('inv_abc123'),
        )
        // Revoking moves the row out of the Active filter, so the list is
        // re-fetched rather than patched — leaving a "Revoked" row in the
        // Active list would be a lie.
        await waitFor(() =>
            expect(adminUserService.listInvites).toHaveBeenCalledTimes(2),
        )
    })

    it('offers no revoke button for a link that is already revoked', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ status: 'revoked', revokedAt: new Date().toISOString() }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText('Revoked')).toBeInTheDocument()
        expect(screen.queryByTitle('Revoke this link')).not.toBeInTheDocument()
    })

    it('fetches redemptions lazily, only when a row is opened', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 1, redemptionCount: 1 }),
        ])
        vi.mocked(adminUserService.listInviteRedemptions).mockResolvedValue([
            {
                id: 'invr_1', userId: 'usr_1',
                email: 'joined@company.com',
                redeemedAt: new Date(Date.now() - HOUR).toISOString(),
            },
        ])
        render(<AdminInvites />)
        await screen.findByText('Anyone with the link')

        // Not fetched on load — most rows are never expanded.
        expect(adminUserService.listInviteRedemptions).not.toHaveBeenCalled()

        fireEvent.click(screen.getByTitle('Show who used this link'))

        expect(await screen.findByText('joined@company.com')).toBeInTheDocument()
        expect(adminUserService.listInviteRedemptions).toHaveBeenCalledWith('inv_abc123')
    })

    it('cannot expand a link nobody has used', async () => {
        render(<AdminInvites />)
        await screen.findByText('Anyone with the link')

        expect(screen.getByTitle('Nobody has used this link yet')).toBeDisabled()
    })

    it('refetches when the status filter changes', async () => {
        render(<AdminInvites />)
        await screen.findByText('Anyone with the link')

        fireEvent.click(screen.getByRole('button', { name: 'Revoked' }))

        await waitFor(() =>
            expect(adminUserService.listInvites).toHaveBeenLastCalledWith('revoked'),
        )
    })

    it('flags a link that is nearly out of seats', async () => {
        // A link about to close itself is the one an admin needs to notice
        // before somebody is turned away at the door.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 4, maxUses: 5 }),
        ])
        render(<AdminInvites />)

        const seats = await screen.findByTitle('4 of 5 used · 1 left')
        expect(seats.className).toMatch(/amber/)
    })

    it('tops up seats only on a capped link', async () => {
        // Adding seats to an uncapped link would silently impose a limit
        // that was never there.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([invite({ maxUses: null })])
        vi.mocked(adminUserService.extendInvite).mockResolvedValue(invite())
        render(<AdminInvites />)

        fireEvent.click(await screen.findByRole('button', { name: /extend/i }))

        await waitFor(() =>
            expect(adminUserService.extendInvite).toHaveBeenCalledWith(
                'inv_abc123', { expiresInHours: 720, additionalUses: null },
            ),
        )
    })

    it('does not regenerate until the consequence is accepted', async () => {
        render(<AdminInvites />)

        fireEvent.click(await screen.findByRole('button', { name: /new url/i }))

        expect(await screen.findByText(/issue a new url/i)).toBeInTheDocument()
        expect(screen.getByText(/loses it, immediately/i)).toBeInTheDocument()
        expect(adminUserService.regenerateInvite).not.toHaveBeenCalled()
    })

    it('shows the regenerated URL once, and says so', async () => {
        vi.mocked(adminUserService.regenerateInvite).mockResolvedValue({
            inviteToken: 'fresh.jwt.token', role: null, workspaceId: null,
            email: null, groupIds: null, expiresAt: new Date().toISOString(),
            inviteId: 'inv_abc123', maxUses: null, emailDomain: null,
        })
        render(<AdminInvites />)

        fireEvent.click(await screen.findByRole('button', { name: /new url/i }))
        fireEvent.click(await screen.findByRole('button', { name: /generate new url/i }))

        expect(await screen.findByText(/signup\?invite=fresh\.jwt\.token/)).toBeInTheDocument()
        expect(screen.getByText(/not shown again/i)).toBeInTheDocument()
    })

    it('offers neither extend nor regenerate on a revoked link', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ status: 'revoked', revokedAt: new Date().toISOString() }),
        ])
        render(<AdminInvites />)
        await screen.findByText('Revoked')

        expect(screen.queryByRole('button', { name: /extend/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /new url/i })).not.toBeInTheDocument()
    })

    it('surfaces a load failure instead of showing an empty list', async () => {
        vi.mocked(adminUserService.listInvites).mockRejectedValue(
            new Error('Backend unavailable'),
        )
        render(<AdminInvites />)

        expect(await screen.findByText('Backend unavailable')).toBeInTheDocument()
    })

    it('never renders a token, even if one somehow arrives', async () => {
        // The list endpoint deliberately omits tokens: a read-only view
        // must not become somewhere credentials can be harvested.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            { ...invite(), inviteToken: 'leaked.jwt.value' } as unknown as InviteSummary,
        ])
        const { container } = render(<AdminInvites />)
        await screen.findByText('Anyone with the link')

        expect(container.textContent).not.toContain('leaked.jwt.value')
    })
})
