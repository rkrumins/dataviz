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

/** Actions live behind the overflow menu — three labelled buttons per row
 *  is what crushed the identity column in the first design. */
async function openRowMenu() {
    fireEvent.click(await screen.findByLabelText('Actions for this link'))
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminUserService.listInvites).mockResolvedValue([invite()])
})

describe('AdminInvites — reading a row', () => {
    it('never truncates what the link grants or who it is for', async () => {
        // The bug this layout exists to prevent: the identity column was
        // sharing one flex row with three buttons and two fixed-width
        // metrics, and collapsed to "No r…" / "Anyo…".
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ role: null, workspaceName: null }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText('Account only')).toBeInTheDocument()
        expect(screen.getByText('Anyone with the link')).toBeInTheDocument()
    })

    it('shows the role, workspace and audience together', async () => {
        render(<AdminInvites />)

        expect(await screen.findByText(/in Finance/)).toBeInTheDocument()
        expect(screen.getByText('Anyone with the link')).toBeInTheDocument()
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

        expect(await screen.findByText('Anyone @company.com')).toBeInTheDocument()
    })

    it('meters seat usage against the cap', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 3, maxUses: 10 }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByTitle('3 of 10 used · 7 left')).toBeInTheDocument()
    })

    it('flags a link that is nearly out of seats, and says what to do', async () => {
        // A status word says what IS; the nudge says what to do about it.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 4, maxUses: 5 }),
        ])
        render(<AdminInvites />)

        const seats = await screen.findByTitle('4 of 5 used · 1 left')
        expect(seats.innerHTML).toMatch(/amber/)
        expect(screen.getByText(/one seat left/i)).toBeInTheDocument()
    })

    it('nudges a link that is out of seats', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 5, maxUses: 5, status: 'active' }),
        ])
        render(<AdminInvites />)

        expect(await screen.findByText(/out of seats/i)).toBeInTheDocument()
    })
})

describe('AdminInvites — summary and filters', () => {
    it('counts states the current tab is hiding', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ id: 'a', redemptionCount: 2 }),
            invite({ id: 'b', status: 'revoked', revokedAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
            invite({ id: 'c', useCount: 5, maxUses: 5 }),
        ])
        render(<AdminInvites />)

        // Everything is fetched once and filtered in memory, so the summary
        // can count what the Active tab is not showing.
        await screen.findByText('People joined')
        expect(adminUserService.listInvites).toHaveBeenCalledWith('all')
        expect(adminUserService.listInvites).toHaveBeenCalledTimes(1)
    })

    it('switches tabs without refetching', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ id: 'a' }),
            invite({ id: 'b', status: 'revoked', revokedAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
        ])
        render(<AdminInvites />)
        await screen.findByText(/in Finance/)

        fireEvent.click(screen.getByRole('button', { name: /^Revoked/ }))

        await waitFor(() =>
            expect(screen.getByText(/revoked .* ago/i)).toBeInTheDocument(),
        )
        expect(adminUserService.listInvites).toHaveBeenCalledTimes(1)
    })

    it('offers a way out of an empty tab when links exist elsewhere', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([invite()])
        render(<AdminInvites />)
        await screen.findByText(/in Finance/)

        fireEvent.click(screen.getByRole('button', { name: /^Expired/ }))

        expect(await screen.findByText(/nothing has expired/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /show all links/i })).toBeInTheDocument()
    })

    it('guides toward creating one when there are none at all', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([])
        const onCreate = vi.fn()
        render(<AdminInvites onCreate={onCreate} />)

        expect(await screen.findByText(/no links are active right now/i)).toBeInTheDocument()

        // The empty state carries the action, not just the news. The
        // top-of-panel button is suppressed here so there is exactly one
        // thing to click.
        expect(screen.queryByRole('button', { name: /new invite link/i })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /create your first link/i }))
        expect(onCreate).toHaveBeenCalledTimes(1)
    })

    it('can create a link from the panel that manages them', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([invite()])
        const onCreate = vi.fn()
        render(<AdminInvites onCreate={onCreate} />)
        await screen.findByText(/in Finance/)

        fireEvent.click(screen.getByRole('button', { name: /new invite link/i }))
        expect(onCreate).toHaveBeenCalledTimes(1)
    })

    it('finds a link by who it is for, and says so when nothing matches', async () => {
        // Search only appears once the list is big enough to need it.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ id: 'inv_1', email: 'alice@company.com' }),
            invite({ id: 'inv_2', email: 'bob@company.com' }),
            invite({ id: 'inv_3', email: 'carol@company.com' }),
            invite({ id: 'inv_4', email: 'dave@company.com' }),
            invite({ id: 'inv_5', email: 'erin@company.com' }),
            invite({ id: 'inv_6', email: 'frank@company.com' }),
        ])
        render(<AdminInvites />)
        await screen.findByText('alice@company.com')

        const box = screen.getByPlaceholderText(/search by person/i)
        fireEvent.change(box, { target: { value: 'carol' } })

        expect(screen.getByText('carol@company.com')).toBeInTheDocument()
        expect(screen.queryByText('alice@company.com')).not.toBeInTheDocument()

        fireEvent.change(box, { target: { value: 'nobody' } })
        expect(screen.getByText(/nothing matches that search/i)).toBeInTheDocument()
    })
})

describe('AdminInvites — acting on a link', () => {
    it('does not revoke until the confirmation is accepted', async () => {
        render(<AdminInvites />)
        await openRowMenu()

        fireEvent.click(await screen.findByRole('button', { name: 'Revoke this link' }))

        expect(await screen.findByText(/revoke this invite link\?/i)).toBeInTheDocument()
        expect(adminUserService.revokeInvite).not.toHaveBeenCalled()
    })

    it('names the blast radius in the confirmation', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ useCount: 4, redemptionCount: 4 }),
        ])
        render(<AdminInvites />)
        await openRowMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Revoke this link' }))

        expect(
            await screen.findByText(/4 people have already used it/i),
        ).toBeInTheDocument()
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    })

    it('revokes and refreshes once confirmed', async () => {
        vi.mocked(adminUserService.revokeInvite).mockResolvedValue(
            invite({ status: 'revoked', revokedAt: new Date().toISOString() }),
        )
        render(<AdminInvites />)
        await openRowMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Revoke this link' }))
        fireEvent.click(await screen.findByRole('button', { name: /revoke link/i }))

        await waitFor(() =>
            expect(adminUserService.revokeInvite).toHaveBeenCalledWith('inv_abc123'),
        )
        await waitFor(() =>
            expect(adminUserService.listInvites).toHaveBeenCalledTimes(2),
        )
    })

    it('tops up seats only on a capped link', async () => {
        // Adding seats to an uncapped link would silently impose a limit
        // that was never there.
        vi.mocked(adminUserService.listInvites).mockResolvedValue([invite({ maxUses: null })])
        vi.mocked(adminUserService.extendInvite).mockResolvedValue(invite())
        render(<AdminInvites />)
        await openRowMenu()

        fireEvent.click(await screen.findByRole('button', { name: 'Extend this link' }))

        await waitFor(() =>
            expect(adminUserService.extendInvite).toHaveBeenCalledWith(
                'inv_abc123', { expiresInHours: 720, additionalUses: null },
            ),
        )
    })

    it('does not regenerate until the consequence is accepted', async () => {
        render(<AdminInvites />)
        await openRowMenu()

        fireEvent.click(await screen.findByRole('button', { name: 'Issue a new URL' }))

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
        await openRowMenu()
        fireEvent.click(await screen.findByRole('button', { name: 'Issue a new URL' }))
        fireEvent.click(await screen.findByRole('button', { name: /generate new url/i }))

        expect(await screen.findByText(/signup\?invite=fresh\.jwt\.token/)).toBeInTheDocument()
        expect(screen.getByText(/not shown again/i)).toBeInTheDocument()
    })

    it('offers no actions at all on a revoked link', async () => {
        vi.mocked(adminUserService.listInvites).mockResolvedValue([
            invite({ status: 'revoked', revokedAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
        ])
        render(<AdminInvites />)
        // The default tab is Active, which a revoked link is not in.
        fireEvent.click(await screen.findByRole('button', { name: /^Revoked/ }))
        await screen.findByText(/revoked .* ago/i)

        expect(screen.queryByLabelText('Actions for this link')).not.toBeInTheDocument()
    })
})

describe('AdminInvites — redemption history', () => {
    it('fetches lazily, only when a row is opened', async () => {
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
        await screen.findByText(/in Finance/)

        // Not fetched on load — most rows are never expanded.
        expect(adminUserService.listInviteRedemptions).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: /1 person joined/i }))

        expect(await screen.findByText('joined@company.com')).toBeInTheDocument()
        expect(adminUserService.listInviteRedemptions).toHaveBeenCalledWith('inv_abc123')
    })

    it('offers no expander for a link nobody has used', async () => {
        render(<AdminInvites />)
        await screen.findByText(/in Finance/)

        expect(screen.queryByRole('button', { name: /joined/i })).not.toBeInTheDocument()
    })
})

describe('AdminInvites — failure and disclosure', () => {
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
        await screen.findByText(/in Finance/)

        expect(container.textContent).not.toContain('leaked.jwt.value')
    })
})
