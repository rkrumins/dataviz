/**
 * Answering a request offers the decisions the workspace's way of letting
 * people in allows: a role (within what the approver may grant, with an end
 * date) or a team where it is decided here; a group to join, or an exception
 * said out loud, where the identity provider decides — the admins' alone,
 * and always ending. A request to keep access is answered with how much
 * longer. Whatever is granted, the dialog names the data sources it reads.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { members, requests, notify } = vi.hoisted(() => ({
    members: { grantOptions: vi.fn() },
    requests: { approve: vi.fn(), route: vi.fn(), deny: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: requests,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { ApproveRequestDialog } from '../ApproveRequestDialog'
import type { AccessRequestResponse } from '@/services/accessRequestsService'
import type { WorkspaceGrantOptions } from '@/services/workspaceMembersService'

const REQUEST: AccessRequestResponse = {
    id: 'ar_1', requester: { id: 'usr_ana', email: 'ana@x.io', displayName: 'Ana', ssoLinked: false },
    target: { type: 'workspace', id: 'ws_fin', label: 'Finance', accessMode: 'app' },
    requestedRole: 'workspace_member', justification: 'Closing the quarter', status: 'pending',
    createdAt: '2026-10-18T09:00:00Z', resolvedAt: null, resolvedBy: null, resolutionNote: null,
}

function options(over: Partial<WorkspaceGrantOptions> = {}): WorkspaceGrantOptions {
    return {
        tier: 'admin', accessMode: 'app',
        roles: [
            { name: 'workspace_viewer', description: 'Read-only', isSystem: true },
            { name: 'workspace_member', description: 'Contributor', isSystem: true },
        ],
        groups: [], idpRoutes: [],
        ...over,
    }
}

function renderDialog(request = REQUEST) {
    const onClose = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <ApproveRequestDialog request={request} onClose={onClose} />
        </QueryClientProvider>,
    )
    return { onClose }
}

beforeEach(() => {
    vi.clearAllMocks()
    requests.approve.mockResolvedValue({ ...REQUEST, status: 'approved' })
    requests.route.mockResolvedValue({ ...REQUEST, status: 'awaiting_idp' })
})

describe('ApproveRequestDialog — keeping access', () => {
    it('lets them keep it for 30 days unless told otherwise', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options())
        renderDialog({ ...REQUEST, bindingId: 'bnd_1', currentExpiresAt: '2026-10-22T00:00:00Z' })

        expect(screen.getByRole('heading', { name: 'Let Ana keep their access to Finance?' })).toBeInTheDocument()
        expect(screen.getByText(/access ends on/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')
        // No role or team to choose: the grant stays what it is.
        expect(screen.queryByRole('radio', { name: /Member/ })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Let them keep it' }))

        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', { expiresIn: '30d', note: null }))
        expect(notify).toHaveBeenCalledWith('success', 'Ana keeps their access to Finance for 30 days.')
    })
})

describe('ApproveRequestDialog — decided here', () => {
    it('grants what was asked, until the date chosen', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options())
        const { onClose } = renderDialog()

        expect(screen.getByRole('dialog', { name: 'Answer Ana’s request' })).toBeInTheDocument()
        expect(screen.getByText('“Closing the quarter”')).toBeInTheDocument()
        const member = await screen.findByRole('radio', { name: /Member/ })
        expect(member).toHaveAttribute('aria-checked', 'true')
        expect(member).toHaveTextContent('What they asked for')

        await user.click(screen.getByRole('radio', { name: '30 days' }))
        await user.type(screen.getByRole('textbox'), 'Welcome')
        await user.click(screen.getByRole('button', { name: 'Approve' }))

        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', {
            role: 'workspace_member', expiresIn: '30d', exception: false, note: 'Welcome',
        }))
        expect(onClose).toHaveBeenCalled()
    })

    it('adds the person to a team when one is offered', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options({
            groups: [{ id: 'grp_close', name: 'Close team', memberCount: 6, roles: ['workspace_member'] }],
        }))
        renderDialog()
        await user.click(await screen.findByRole('radio', { name: /Add to a team/ }))
        await user.click(screen.getByRole('radio', { name: /Close team/ }))
        await user.click(screen.getByRole('button', { name: 'Add to team' }))
        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', { groupId: 'grp_close', note: null }))
    })

    it('tells a steward what they may grant', async () => {
        members.grantOptions.mockResolvedValue(options({ tier: 'steward' }))
        renderDialog()
        expect(await screen.findByText('Level (stewards grant Viewer or Member)')).toBeInTheDocument()
    })
})

describe('ApproveRequestDialog — the identity provider decides', () => {
    const idpRequest = { ...REQUEST, target: { ...REQUEST.target, accessMode: 'idp' as const } }

    it('points to a group, warning when the person has never signed in through it', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options({
            accessMode: 'idp',
            idpRoutes: [{ idpGroup: 'finance-analysts', provider: 'Entra ID', role: 'workspace_viewer', viaGroupId: null, viaGroupName: null }],
        }))
        renderDialog(idpRequest)
        expect(await screen.findByRole('radio', { name: /finance-analysts/ })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByText(/never signed in through your identity provider/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Point to group' }))
        await waitFor(() => expect(requests.route).toHaveBeenCalledWith('ar_1', { idpGroup: 'finance-analysts', note: null }))
    })

    it('grants an exception for 30 days unless told otherwise, said out loud, and always ending', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options({ accessMode: 'idp' }))
        renderDialog(idpRequest)
        await user.click(await screen.findByRole('radio', { name: /Grant an exception/ }))
        expect(screen.getByText(/outside your identity provider/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.queryByRole('radio', { name: 'No end date' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Grant exception' }))
        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', {
            role: 'workspace_member', expiresIn: '30d', exception: true, note: null,
        }))
    })

    it('leaves exceptions to the admins: a steward points to a group', async () => {
        members.grantOptions.mockResolvedValue(options({ accessMode: 'idp', tier: 'steward' }))
        renderDialog(idpRequest)
        expect(await screen.findByText(/only the workspace’s admins can grant an exception/)).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: /Grant an exception/ })).not.toBeInTheDocument()
    })

    it('keeps an exception going only as an exception, with an end — and only for an admin', async () => {
        const user = userEvent.setup()
        const keep = { ...idpRequest, bindingId: 'bnd_1', idpException: true, currentExpiresAt: '2026-10-25T00:00:00Z' }
        members.grantOptions.mockResolvedValue(options({ accessMode: 'idp' }))
        renderDialog(keep)
        expect(await screen.findByText(/Keeping it keeps it as one/)).toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: 'No end date' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Let them keep it' }))
        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', {
            expiresIn: '30d', note: null, exception: true,
        }))
    })

    it('tells a steward that keeping an exception is the admins’ call', async () => {
        const keep = { ...idpRequest, bindingId: 'bnd_1', idpException: true }
        members.grantOptions.mockResolvedValue(options({ accessMode: 'idp', tier: 'steward' }))
        renderDialog(keep)
        expect(await screen.findByRole('alert')).toHaveTextContent(/Only the workspace’s admins can keep an exception going/)
        expect(screen.getByRole('button', { name: 'Let them keep it' })).toBeDisabled()
    })
})

describe('ApproveRequestDialog — what a grant opens', () => {
    it('names every data source the role reads, restricted ones first', async () => {
        members.grantOptions.mockResolvedValue(options({
            dataSources: [
                { id: 'ds_led', label: 'Ledger', restricted: false },
                { id: 'ds_hr', label: 'HR warehouse', restricted: true },
            ],
        }))
        renderDialog()
        const note = await screen.findByRole('note')
        expect(note).toHaveTextContent('Any role here reads all 2 data sources in this workspace, restricted ones included: HR warehouse, Ledger.')
    })
})

const FOR_AN_ACCOUNT: AccessRequestResponse = {
    ...REQUEST,
    requester: { id: 'svc_sync', email: 'svc_sync@service-account.invalid', displayName: 'Metadata sync' },
    serviceAccount: {
        description: 'Reads graph metadata nightly',
        managers: [
            { type: 'user', name: 'Ada Lovelace', fromIdp: false },
            { type: 'group', name: 'Data platform', fromIdp: true },
        ],
    },
    requestedBy: { id: 'usr_ada', email: 'ada@x.io', displayName: 'Ada Lovelace' },
}

describe('ApproveRequestDialog — for a service account', () => {
    it('says whose it is, and grants only a role it may hold — never a team', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options({
            groups: [{ id: 'grp_1', name: 'Analysts', memberCount: 3, roles: ['workspace_member'] }],
            roles: [
                { name: 'workspace_admin', description: 'Everything', isSystem: true, requestable: false },
                { name: 'workspace_viewer', description: 'Read-only', isSystem: true, requestable: true },
                { name: 'workspace_member', description: 'Contributor', isSystem: true, requestable: true },
            ],
        }))
        renderDialog(FOR_AN_ACCOUNT)

        expect(screen.getByText('Service account: Reads graph metadata nightly')).toBeInTheDocument()
        expect(screen.getByText(/Managed by Ada Lovelace, Data platform \(from your identity provider\)/)).toBeInTheDocument()
        expect(screen.getByText('Asked by Ada Lovelace')).toBeInTheDocument()
        expect(await screen.findByRole('radio', { name: /Member/ })).toHaveAttribute('aria-checked', 'true')
        expect(screen.queryByRole('radio', { name: /Admin/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('radio', { name: /Add to a team/ })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Approve' }))
        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', {
            role: 'workspace_member', expiresIn: null, exception: false, note: null,
        }))
    })

    it('leaves it to the admins where the identity provider decides, never pointing to a group', async () => {
        members.grantOptions.mockResolvedValue(options({ tier: 'steward', accessMode: 'idp' }))
        renderDialog({ ...FOR_AN_ACCOUNT, target: { ...REQUEST.target, accessMode: 'idp' } })

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'only the workspace’s admins give a service account access here',
        )
        expect(screen.queryByRole('radio', { name: /Point to a group/ })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    })
})
