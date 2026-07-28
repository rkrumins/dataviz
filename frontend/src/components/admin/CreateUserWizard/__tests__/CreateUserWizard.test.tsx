/**
 * Creating accounts directly — the rules, not the markup.
 *
 * The two that matter: the credential choice actually reaches the
 * server (it decides whether anyone ever knows the password), and a
 * shared password is never offered for a batch, because the server
 * refuses it and offering it would only produce a 400.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CreateUserWizard } from '../CreateUserWizard'
import { deriveName } from '../useCreateUser'

vi.mock('@/services/permissionsService', () => ({ permissionsService: { listRoles: vi.fn() } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: vi.fn() } }))
vi.mock('@/services/groupsService', () => ({ groupsService: { list: vi.fn() } }))

import { permissionsService } from '@/services/permissionsService'
import { workspaceService } from '@/services/workspaceService'
import { groupsService } from '@/services/groupsService'

const ROLES = [
    { name: 'user', description: 'Standard.', permissions: [], isSystem: true, scopeType: 'global', scopeId: null },
    { name: 'org_admin', description: 'Cross-workspace operator.', permissions: ['system:admin'], isSystem: true, scopeType: 'global', scopeId: null },
] as never

function setup(over: Partial<Parameters<typeof CreateUserWizard>[0]> = {}) {
    const onSubmit = vi.fn()
    const onSubmitBulk = vi.fn()
    const onClose = vi.fn()
    render(
        <CreateUserWizard
            canGrantSuperAdmin loading={false} error={null}
            result={null} bulkResult={null}
            onSubmit={onSubmit} onSubmitBulk={onSubmitBulk}
            onAnother={vi.fn()} onClose={onClose}
            {...over}
        />,
    )
    return { onSubmit, onSubmitBulk, onClose }
}

const nextBtn = () => screen.getByRole('button', { name: /^next/i })
async function goNext(heading: RegExp) {
    fireEvent.click(nextBtn())
    await screen.findByText(heading)
}
const S2 = /what will they get/i
const S3 = /how will they get in/i
const S4 = /review and create/i

async function onePerson() {
    await screen.findByText(/who are you adding/i)
    fireEvent.change(screen.getByPlaceholderText('grace@company.com'), {
        target: { value: 'grace@company.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('Grace'), { target: { value: 'Grace' } })
}

beforeEach(() => {
    vi.mocked(permissionsService.listRoles).mockReset().mockResolvedValue(ROLES)
    vi.mocked(workspaceService.list).mockReset().mockResolvedValue([])
    vi.mocked(groupsService.list).mockReset().mockResolvedValue([])
})

describe('deriveName', () => {
    it('turns an address into a name a list can render', () => {
        expect(deriveName('grace.hopper@company.com')).toEqual({ first: 'Grace', last: 'Hopper' })
        expect(deriveName('ada@company.com')).toEqual({ first: 'Ada', last: '' })
        expect(deriveName('a_b_c@company.com')).toEqual({ first: 'A', last: 'B C' })
    })
})

describe('CreateUserWizard — who', () => {
    it('will not advance without an address and a first name', async () => {
        setup()
        await screen.findByText(/who are you adding/i)
        expect(nextBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText('grace@company.com'), {
            target: { value: 'grace@company.com' },
        })
        expect(nextBtn()).toBeDisabled()          // no name yet

        fireEvent.change(screen.getByPlaceholderText('Grace'), { target: { value: 'Grace' } })
        expect(nextBtn()).toBeEnabled()
    })

    it('offers the name the address already implies', async () => {
        setup()
        await screen.findByText(/who are you adding/i)
        fireEvent.change(screen.getByPlaceholderText('grace@company.com'), {
            target: { value: 'grace.hopper@company.com' },
        })
        fireEvent.click(screen.getByRole('button', { name: /use “grace hopper”/i }))
        expect(screen.getByPlaceholderText('Grace')).toHaveValue('Grace')
        expect(screen.getByPlaceholderText('Hopper')).toHaveValue('Hopper')
    })

    it('parses a pasted list, including Name <addr> and duplicates', async () => {
        setup()
        await screen.findByText(/who are you adding/i)
        fireEvent.click(screen.getByText('A list of people'))
        fireEvent.change(screen.getByPlaceholderText(/grace.hopper@company.com/), {
            target: { value: 'a@x.com\nAda Lovelace <ada@x.com>\na@x.com\nnot-an-address' },
        })
        // 2 unique valid + 1 invalid; the repeat is dropped silently.
        expect(screen.getByText(/2 will be created; 1 line is not a valid address/i))
            .toBeInTheDocument()
    })
})

describe('CreateUserWizard — how they sign in', () => {
    it('defaults to a setup link, so nobody knows the password', async () => {
        const { onSubmit } = setup()
        await onePerson()
        await goNext(S2); await goNext(S3); await goNext(S4)

        fireEvent.click(screen.getByRole('button', { name: /create account/i }))
        expect(onSubmit.mock.calls[0][0].body.credential).toBe('setup_link')
    })

    it('requires a long enough password when the admin sets one', async () => {
        setup()
        await onePerson()
        await goNext(S2); await goNext(S3)

        fireEvent.click(screen.getByText('Set a password yourself'))
        expect(nextBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText(/at least 12 characters/i), {
            target: { value: 'short' },
        })
        expect(nextBtn()).toBeDisabled()

        fireEvent.change(screen.getByPlaceholderText(/at least 12 characters/i), {
            target: { value: 'a-long-enough-password' },
        })
        expect(nextBtn()).toBeEnabled()
    })

    it('never offers a shared password for a batch', async () => {
        setup()
        await screen.findByText(/who are you adding/i)
        fireEvent.click(screen.getByText('A list of people'))
        fireEvent.change(screen.getByPlaceholderText(/grace.hopper@company.com/), {
            target: { value: 'a@x.com\nb@x.com' },
        })
        await goNext(S2); await goNext(S3)

        expect(screen.getByText('Send them a setup link')).toBeInTheDocument()
        expect(screen.getByText('Single sign-on only')).toBeInTheDocument()
        // A password twenty people know is not a credential, and the
        // server refuses it — so it is not on offer here either.
        expect(screen.queryByText('Set a password yourself')).not.toBeInTheDocument()
    })

    it('can park an account in the pending queue instead of activating it', async () => {
        const { onSubmit } = setup()
        await onePerson()
        await goNext(S2); await goNext(S3)

        fireEvent.click(screen.getByRole('checkbox'))
        await goNext(S4)
        fireEvent.click(screen.getByRole('button', { name: /create account/i }))
        expect(onSubmit.mock.calls[0][0].body.activate).toBe(false)
    })
})

describe('CreateUserWizard — submitting', () => {
    it('sends one account with everything chosen', async () => {
        const { onSubmit } = setup()
        await onePerson()
        fireEvent.change(screen.getByPlaceholderText('Hopper'), { target: { value: 'Hopper' } })
        await goNext(S2); await goNext(S3); await goNext(S4)

        fireEvent.click(screen.getByRole('button', { name: /create account/i }))
        const body = onSubmit.mock.calls[0][0].body
        expect(body.email).toBe('grace@company.com')
        expect(body.firstName).toBe('Grace')
        expect(body.lastName).toBe('Hopper')
    })

    it('sends every valid row of a batch and says how many', async () => {
        const { onSubmitBulk } = setup()
        await screen.findByText(/who are you adding/i)
        fireEvent.click(screen.getByText('A list of people'))
        fireEvent.change(screen.getByPlaceholderText(/grace.hopper@company.com/), {
            target: { value: 'a@x.com\nb@x.com\nc@x.com' },
        })
        await goNext(S2); await goNext(S3); await goNext(S4)

        fireEvent.click(screen.getByRole('button', { name: /create 3 accounts/i }))
        await waitFor(() => expect(onSubmitBulk).toHaveBeenCalledTimes(1))
        expect(onSubmitBulk.mock.calls[0][0].body.users.map((u: {email: string}) => u.email))
            .toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    })

    it('warns before creating that an admin-set password is not sent for them', async () => {
        setup()
        await onePerson()
        await goNext(S2); await goNext(S3)
        fireEvent.click(screen.getByText('Set a password yourself'))
        fireEvent.change(screen.getByPlaceholderText(/at least 12 characters/i), {
            target: { value: 'a-long-enough-password' },
        })
        await goNext(S4)

        expect(screen.getByText(/pass this password on yourself/i)).toBeInTheDocument()
    })
})

describe('CreateUserWizard — after', () => {
    it('shows the setup link once, and says so', async () => {
        setup({
            result: {
                id: 'u1', email: 'grace@company.com', firstName: 'Grace', lastName: 'Hopper',
                status: 'active', role: null, workspaceId: null, groupIds: [],
                setupToken: 'tok-123', setupExpiresAt: null,
            },
        })
        // Both the header subtitle and the heading say it — the heading
        // is the one that matters here.
        expect(await screen.findByRole('heading', { name: /account created/i }))
            .toBeInTheDocument()
        expect(screen.getByText(/it is shown once/i)).toBeInTheDocument()
        expect((screen.getByLabelText('Setup link') as HTMLInputElement).value)
            .toContain('token=tok-123')
    })

    it('reports every row of a batch, including the ones that were skipped', async () => {
        setup({
            bulkResult: {
                created: 1, skipped: 1,
                results: [
                    { email: 'a@x.com', outcome: 'created', userId: 'u1', setupToken: 't1', detail: null },
                    { email: 'b@x.com', outcome: 'already_a_user', userId: null, setupToken: null, detail: null },
                ],
            },
        })
        expect(await screen.findByRole('heading', { name: /1 account created/i }))
            .toBeInTheDocument()
        expect(screen.getByText('Created')).toBeInTheDocument()
        expect(screen.getByText('Already had an account')).toBeInTheDocument()
    })
})
