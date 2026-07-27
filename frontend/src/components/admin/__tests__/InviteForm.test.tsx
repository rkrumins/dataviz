/**
 * The invite flow's rules, not its markup.
 *
 * Two things are worth locking down here. The first is that an open link
 * arrives bounded — the form used to default to "anyone with the link ·
 * unlimited · 30 days", the widest invite it can mint, and left it to the
 * admin to notice. The second is that the email-pin rule for privileged
 * roles and group attachments survived being split across three steps:
 * that rule is the reason a forwarded link cannot escalate someone.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InviteForm } from '../AdminUsers'

vi.mock('@/services/permissionsService', () => ({
    permissionsService: { listRoles: vi.fn() },
}))
vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: vi.fn() },
}))
vi.mock('@/services/groupsService', () => ({
    groupsService: { list: vi.fn() },
}))

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

function setup(over: Partial<Parameters<typeof InviteForm>[0]> = {}) {
    const onSubmit = vi.fn()
    const onSubmitBulk = vi.fn()
    render(
        <InviteForm
            canGrantSuperAdmin
            loading={false}
            onCancel={vi.fn()}
            onSubmit={onSubmit}
            onSubmitBulk={onSubmitBulk}
            {...over}
        />,
    )
    return { onSubmit, onSubmitBulk }
}

const continueBtn = () => screen.getByRole('button', { name: /continue/i })

/** Steps cross-fade, and framer-motion's exit does not settle synchronously
 *  in jsdom — so advancing has to wait for the next step to actually be on
 *  screen rather than assume the click was enough. */
async function goNext(expectHeading: RegExp) {
    fireEvent.click(continueBtn())
    await screen.findByText(expectHeading)
}
const STEP2 = /what will they get/i
const STEP3 = /review and generate/i

beforeEach(() => {
    vi.mocked(permissionsService.listRoles).mockReset().mockResolvedValue(ROLES)
    vi.mocked(workspaceService.list).mockReset().mockResolvedValue([])
    vi.mocked(groupsService.list).mockReset().mockResolvedValue([])
})

describe('InviteForm — the audience question comes first', () => {
    it('asks who the link is for before anything else', async () => {
        setup()
        expect(await screen.findByText(/who is this link for/i)).toBeInTheDocument()
        // None of the later decisions are on screen yet.
        expect(screen.queryByText(/what will they get/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/link expires in/i)).not.toBeInTheDocument()
    })

    it('will not advance until the chosen audience is actually filled in', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        expect(continueBtn()).toBeDisabled()

        fireEvent.click(screen.getByText('One specific person'))
        expect(continueBtn()).toBeDisabled()          // no address yet

        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'not-an-email' },
        })
        expect(continueBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        expect(continueBtn()).toBeEnabled()
    })

    it('only asks for a domain when the audience is a domain', async () => {
        setup()
        await screen.findByText(/who is this link for/i)

        fireEvent.click(screen.getByText('Anyone at a domain'))
        expect(screen.getByPlaceholderText('company.com')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Anyone with the link'))
        expect(screen.queryByPlaceholderText('company.com')).not.toBeInTheDocument()
    })
})

describe('InviteForm — an open link arrives bounded', () => {
    /** The headline behaviour change. Previously this combination was the
     *  default and nothing said so. */
    it('caps an anyone-with-the-link invite instead of leaving it unlimited', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)

        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(STEP2)
        await goNext(STEP3)
        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))

        expect(onSubmit).toHaveBeenCalledTimes(1)
        const [, opts] = onSubmit.mock.calls[0]
        expect(opts.maxUses).toBe(5)
        expect(opts.expiresInHours).toBe(24 * 7)
    })

    it('says so on the way past, rather than only in the summary', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))

        expect(screen.getByText(/anyone who ends up with the URL can use it/i)).toBeInTheDocument()
        expect(screen.getByText(/capped at 5 people and 7 days/i)).toBeInTheDocument()
    })

    it('pins a single-person invite to one seat', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)

        fireEvent.click(screen.getByText('One specific person'))
        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        await goNext(STEP2)
        await goNext(STEP3)
        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))

        const [, opts] = onSubmit.mock.calls[0]
        expect(opts.maxUses).toBe(1)
        expect(opts.email).toBe('alice@company.com')
    })

    it('does not offer a seat cap for a link pinned to one address', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('One specific person'))
        fireEvent.change(screen.getByPlaceholderText('user@company.com'), {
            target: { value: 'alice@company.com' },
        })
        await goNext(STEP2)
        await goNext(STEP3)

        expect(screen.getByText(/link expires in/i)).toBeInTheDocument()
        expect(screen.queryByText(/how many people can use it/i)).not.toBeInTheDocument()
    })

    it('still lets an admin choose unlimited, and warns when they do', async () => {
        const { onSubmit } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(STEP2)
        await goNext(STEP3)

        fireEvent.click(screen.getByRole('button', { name: /^Unlimited$/ }))
        expect(screen.getByText(/nothing closes this link but its expiry/i)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /generate link/i }))
        expect(onSubmit.mock.calls[0][1].maxUses).toBeNull()
    })
})

describe('InviteForm — the email-pin rule survives the split', () => {
    it('blocks a privileged role on a shareable link, and offers the way out', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(STEP2)

        fireEvent.click(await screen.findByText('Org admin'))

        expect(screen.getByText(/cannot go on a shareable link/i)).toBeInTheDocument()
        expect(continueBtn()).toBeDisabled()

        // The offered resolution actually resolves it.
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
        await goNext(STEP2)

        fireEvent.click(await screen.findByText('Org admin'))

        expect(screen.queryByText(/cannot go on a shareable link/i)).not.toBeInTheDocument()
        expect(continueBtn()).toBeEnabled()
    })
})

describe('InviteForm — the review step', () => {
    it('describes the whole invite in a sentence before it exists', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone at a domain'))
        fireEvent.change(screen.getByPlaceholderText('company.com'), {
            target: { value: 'company.com' },
        })
        await goNext(STEP2)
        await goNext(STEP3)

        expect(screen.getByText(/this invite will/i)).toBeInTheDocument()
        expect(screen.getByText(/anyone with an @company\.com address can sign up/i))
            .toBeInTheDocument()
    })

    it('counts the links a bulk invite actually mints', async () => {
        const { onSubmitBulk } = setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Several people'))
        fireEvent.change(screen.getByPlaceholderText(/alice@company.com/), {
            target: { value: 'a@x.com, b@x.com, c@x.com' },
        })
        await goNext(STEP2)
        await goNext(STEP3)

        expect(screen.getByText(/3 separate links, each pinned to one address/i))
            .toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /generate 3 links/i }))
        await waitFor(() => expect(onSubmitBulk).toHaveBeenCalledTimes(1))
        expect(onSubmitBulk.mock.calls[0][0]).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    })

    it('can walk back to a finished step and change its mind', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(STEP2)
        expect(await screen.findByText(/what will they get/i)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /back/i }))
        expect(await screen.findByText(/who is this link for/i)).toBeInTheDocument()
    })
})

describe('InviteForm — role descriptions', () => {
    /** These used to be `truncate`d to one line, cutting every privileged
     *  role's description mid-sentence — on exactly the choices where
     *  knowing what you grant matters most. */
    it('shows a privileged role description in full', async () => {
        setup()
        await screen.findByText(/who is this link for/i)
        fireEvent.click(screen.getByText('Anyone with the link'))
        await goNext(STEP2)

        const desc = await screen.findByText(
            'Cross-workspace operator — manage every workspace plus create new ones.',
        )
        expect(desc).toBeInTheDocument()
        expect(desc.className).not.toMatch(/\btruncate\b/)
    })
})
