/**
 * The wizard's rules, not its markup.
 *
 * Two things are worth locking down. First, that an open link arrives
 * bounded — the dialog this replaces defaulted to "anyone with the link ·
 * unlimited · 30 days", the widest invite it can mint, reached by touching
 * nothing. Second, that the email-pin rule for privileged roles and group
 * attachments survived being split across four steps: that pin is the only
 * thing stopping a forwarded link from escalating whoever opens it.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InviteWizard } from '../InviteWizard'

vi.mock('@/services/permissionsService', () => ({ permissionsService: { listRoles: vi.fn() } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: { list: vi.fn() } }))

import { permissionsService } from '@/services/permissionsService'
import { workspaceService } from '@/services/workspaceService'
import { groupsService } from '@/services/groupsService'

const role = (o: Record<string, unknown>) => ({
    name: 'user', description: 'A description.', permissions: [],
    isSystem: true, scopeType: 'global', scopeId: null, ...o,
} as never)

const ROLES = [
    role({ name: 'user', description: 'Standard.' }),
    role({
        name: 'org_admin',
        description: 'Cross-workspace operator — manage every workspace plus create new ones.',
        permissions: ['system:admin'],
    }),
]

function setup(over: Partial<Parameters<typeof InviteWizard>[0]> = {}) {
    const onSubmit = vi.fn()
    const onSubmitBulk = vi.fn()
    const onClose = vi.fn()
    render(
        <InviteWizard
            canGrantSuperAdmin loading={false}
            result={null} bulkResult={null} inviteUrl="" copied={false}
            onCopy={vi.fn()} onSubmit={onSubmit} onSubmitBulk={onSubmitBulk}
            onAnother={vi.fn()} onClose={onClose}
            {...over}
        />,
    )
    return { onSubmit, onSubmitBulk, onClose }
}

const nextBtn = () => screen.getByRole('button', { name: /^next/i })

/** Steps cross-fade, and framer-motion's exit does not settle
 *  synchronously in jsdom, so advancing has to wait for the next step to
 *  actually be on screen. */
async function goNext(heading: RegExp) {
    fireEvent.click(nextBtn())
    await screen.findByText(heading)
}
const S2 = /what will they get/i

/** Elevation is collapsed by default — that is the point of it, so the
 *  groups picker is reachable without scrolling. Open it to get at the
 *  privileged roles. */
function openElevate() {
    fireEvent.click(screen.getByRole('button', { name: /give them more than that/i }))
}
const S3 = /how far should it reach/i
const S4 = /review and generate/i

async function toDomainStep2() {
    await screen.findByText(/who is this link for/i)
    fireEvent.click(screen.getByText('Anyone at a domain'))
    fireEvent.change(screen.getByPlaceholderText('company.com'), { target: { value: 'company.com' } })
    await goNext(S2)
}

beforeEach(() => {
    vi.mocked(permissionsService.listRoles).mockReset().mockResolvedValue(ROLES)
    vi.mocked(workspaceService.list).mockReset().mockResolvedValue([])
    vi.mocked(groupsService.list).mockReset().mockResolvedValue([])
})

describe('InviteWizard — the audience question comes first', () => {
    it('opens on who the link is for, with nothing else on screen', async () => {
        setup()
        expect(await screen.findByText(/who is this link for/i)).toBeInTheDocument()
        expect(screen.queryByText(S2)).not.toBeInTheDocument()
        expect(screen.queryByText(/link expires in/i)).not.toBeInTheDocument()
    })

    it('will not advance until the chosen audience is filled in', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        expect(nextBtn()).toBeDisabled()

        fireEvent.click(screen.getByText('One specific person'))
        expect(nextBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'not-an-email' },
        })
        expect(nextBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        expect(nextBtn()).toBeEnabled()
    })

    it('swaps the field immediately when the audience changes', async () => {
        setup()
        await screen.findByText(/who is this link for/i)

        fireEvent.click(screen.getByText('Anyone at a domain'))
        expect(screen.getByPlaceholderText('company.com')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Anyone with the link'))
        expect(screen.queryByPlaceholderText('company.com')).not.toBeInTheDocument()
    })
})

describe('InviteWizard — an open link arrives bounded', () => {
    it('caps an anyone-with-the-link invite instead of leaving it unlimited', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(S2); await goNext(S3); await goNext(S4)

        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))
        const [, opts] = onSubmit.mock.calls[0]
        expect(opts.maxUses).toBe(5)
        expect(opts.expiresInHours).toBe(24 * 7)
    })

    it('states the cap on the way past, not only in the summary', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        expect(screen.getByText(/capped at 5 people for 7 days/i)).toBeInTheDocument()
    })

    it('pins a single-person invite to one seat and offers no seat cap', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('One specific person'))
        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        await goNext(S2); await goNext(S3)

        expect(screen.getByText(/link expires in/i)).toBeInTheDocument()
        expect(screen.queryByText(/how many people can use it/i)).not.toBeInTheDocument()

        await goNext(S4)
        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))
        const [, opts] = onSubmit.mock.calls[0]
        expect(opts.maxUses).toBe(1)
        expect(opts.email).toBe('alice@company.com')
    })

    it('still allows unlimited, and warns when it is chosen', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(S2); await goNext(S3)

        fireEvent.click(screen.getByRole('button', { name: /Unlimited/ }))
        expect(screen.getByText(/nothing closes this link but its expiry or a manual revoke/i))
            .toBeInTheDocument()

        await goNext(S4)
        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))
        expect(onSubmit.mock.calls[0][1].maxUses).toBeNull()
    })
})

describe('InviteWizard — reach', () => {
    it('reads wider for an uncapped open link than a pinned one', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('One specific person'))
        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'a@b.com' },
        })
        await goNext(S2); await goNext(S3)
        expect(screen.getByText('Narrow')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /^Back$/ }))
        fireEvent.click(screen.getByRole('button', { name: /who it's for/i }))
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(S2); await goNext(S3)
        fireEvent.click(screen.getByRole('button', { name: /Unlimited/ }))
        fireEvent.click(screen.getByRole('button', { name: /90 days/ }))

        expect(screen.getByText('Wide')).toBeInTheDocument()
    })
})

describe('InviteWizard — the email-pin rule survives the split', () => {
    it('blocks a privileged role on a shareable link and offers the way out', async () => {
        setup()
        await toDomainStep2()

        openElevate()
        fireEvent.click(await screen.findByText('Org admin'))
        expect(screen.getByText(/cannot go on a shareable link/i)).toBeInTheDocument()
        expect(nextBtn()).toBeDisabled()

        fireEvent.click(screen.getByRole('button', { name: /pin it to one person/i }))
        expect(await screen.findByText(/who is this link for/i)).toBeInTheDocument()
        expect(screen.getByPlaceholderText('user@company.com')).toBeInTheDocument()
    })

    it('leaves a privileged role alone when the link is already pinned', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('One specific person'))
        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        await goNext(S2)

        openElevate()
        fireEvent.click(await screen.findByText('Org admin'))
        expect(screen.queryByText(/cannot go on a shareable link/i)).not.toBeInTheDocument()
        expect(nextBtn()).toBeEnabled()
    })

    it('shows a privileged role description in full, not clamped to a line', async () => {
        setup()
        await toDomainStep2()
        openElevate()
        const desc = await screen.findByText(
            'Cross-workspace operator — manage every workspace plus create new ones.',
        )
        expect(desc.className).not.toMatch(/\btruncate\b/)
    })
})

describe('InviteWizard — the access step stays short', () => {
    it('keeps the groups picker reachable by collapsing role elevation', async () => {
        setup()
        await toDomainStep2()

        // Groups are visible without opening anything.
        expect(screen.getByText(/add to groups/i)).toBeInTheDocument()
        // The privileged roles are not competing for that space.
        expect(screen.queryByText('Org admin')).not.toBeInTheDocument()

        openElevate()
        expect(await screen.findByText('Org admin')).toBeInTheDocument()
    })

    it('will not hide a chosen role behind a collapsed disclosure', async () => {
        setup()
        await toDomainStep2()
        openElevate()
        fireEvent.click(await screen.findByText('Org admin'))

        // Collapsing is refused while a role is selected — the summary
        // says which, and the role list stays put.
        fireEvent.click(screen.getByRole('button', { name: /give them more than that/i }))
        expect(screen.getByText('Org admin')).toBeInTheDocument()
        expect(screen.getByText(/selected: org admin/i)).toBeInTheDocument()
    })
})

describe('InviteWizard — navigation', () => {
    it('lets a finished step be revisited from the progress rail', async () => {
        setup()
        await toDomainStep2()

        fireEvent.click(screen.getByRole('button', { name: /who it's for/i }))
        expect(await screen.findByText(/who is this link for/i)).toBeInTheDocument()
    })

    it('does not let an unreached step be jumped to', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        expect(screen.getByRole('button', { name: /review/i })).toBeDisabled()
    })

    it('guards a close that would discard choices, but not an untouched one', async () => {
        const { onClose } = setup()
        await screen.findByText(/who is this link for/i)

        // Nothing chosen — closing is not worth a confirmation.
        fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
        expect(onClose).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByText('Anyone with the link'))
        fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
        expect(await screen.findByText(/discard this invite/i)).toBeInTheDocument()
        expect(onClose).toHaveBeenCalledTimes(1)   // still only the first
    })

    it('counts the links a bulk invite mints, and sends them all', async () => {
        const { onSubmitBulk } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Several people'))
        fireEvent.change(screen.getByPlaceholderText(/alice@company.com/), {
            target: { value: 'a@x.com, b@x.com, c@x.com' },
        })
        await goNext(S2); await goNext(S3); await goNext(S4)

        expect(screen.getByText(/3 separate links, each pinned to one address/i))
            .toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /generate 3 links/i }))
        await waitFor(() => expect(onSubmitBulk).toHaveBeenCalledTimes(1))
        expect(onSubmitBulk.mock.calls[0][0]).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    })
})
