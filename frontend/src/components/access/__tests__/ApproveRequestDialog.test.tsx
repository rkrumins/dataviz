/**
 * Answering a request offers the decisions the workspace's way of letting
 * people in allows: a role (within what the approver may grant, with an end
 * date) or a team where it is decided here; a group to join, or an exception
 * said out loud, where the identity provider decides.
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

    it('grants an exception for 30 days unless told otherwise, said out loud', async () => {
        const user = userEvent.setup()
        members.grantOptions.mockResolvedValue(options({ accessMode: 'idp' }))
        renderDialog(idpRequest)
        await user.click(await screen.findByRole('radio', { name: /Grant an exception/ }))
        expect(screen.getByText(/outside your identity provider/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')
        await user.click(screen.getByRole('button', { name: 'Grant exception' }))
        await waitFor(() => expect(requests.approve).toHaveBeenCalledWith('ar_1', {
            role: 'workspace_member', expiresIn: '30d', exception: true, note: null,
        }))
    })
})
