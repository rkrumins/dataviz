/**
 * The requests someone answers, in one list: open ones with Review and Deny
 * (with a reason the requester sees), All for how each was answered, and —
 * on a workspace's Members tab — nothing at all while nothing waits. A
 * request says how long it has waited, one to keep access says so, and one
 * for a service account says what it is for and who manages it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requests, members, notify } = vi.hoisted(() => ({
    requests: { listToAnswer: vi.fn(), deny: vi.fn(), approve: vi.fn(), route: vi.fn() },
    members: { grantOptions: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: requests,
}))
vi.mock('@/services/workspaceMembersService', () => ({ workspaceMembersService: members }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { ReviewRequestsPanel } from '../ReviewRequestsPanel'
import type { AccessRequestResponse } from '@/services/accessRequestsService'

function request(over: Partial<AccessRequestResponse>): AccessRequestResponse {
    return {
        id: 'ar_x', requester: { id: 'usr_ana', email: 'ana@x.io', displayName: 'Ana' },
        target: { type: 'workspace', id: 'ws_fin', label: 'Finance', accessMode: 'app' },
        requestedRole: 'workspace_member', justification: null, status: 'pending',
        createdAt: '2026-10-18T09:00:00Z', resolvedAt: null, resolvedBy: null, resolutionNote: null,
        ...over,
    }
}

function renderPanel(props: Parameters<typeof ReviewRequestsPanel>[0] = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <ReviewRequestsPanel {...props} />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    members.grantOptions.mockResolvedValue({ tier: 'admin', accessMode: 'app', roles: [], groups: [], idpRoutes: [] })
})

describe('ReviewRequestsPanel', () => {
    it('lists the open requests across workspaces, with Review and Deny', async () => {
        requests.listToAnswer.mockResolvedValue([
            request({ id: 'ar_1', justification: 'Closing the quarter' }),
            request({
                id: 'ar_2', requester: { id: 'usr_bo', email: null, displayName: 'Bo' },
                target: { type: 'workspace', id: 'ws_risk', label: 'Risk', accessMode: 'idp' },
                status: 'awaiting_idp', idpGroup: 'risk-analysts',
            }),
        ])
        renderPanel()

        expect(await screen.findByText('2 waiting')).toBeInTheDocument()
        expect(requests.listToAnswer).toHaveBeenCalledWith({ status: 'open', workspaceId: undefined })
        const ana = screen.getByText('Ana').closest('li') as HTMLElement
        expect(within(ana).getByText('Finance')).toBeInTheDocument()
        expect(within(ana).getByText('“Closing the quarter”')).toBeInTheDocument()
        const bo = screen.getByText('Bo').closest('li') as HTMLElement
        expect(within(bo).getByText('Identity provider')).toBeInTheDocument()
        expect(within(bo).getByText(/pointed to “risk-analysts”/)).toBeInTheDocument()

        await userEvent.click(within(ana).getByRole('button', { name: /Review/ }))
        expect(await screen.findByRole('dialog', { name: 'Answer Ana’s request' })).toBeInTheDocument()
    })

    it('says how long a request has waited, and when the Org Admins were told', async () => {
        const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
        requests.listToAnswer.mockResolvedValue([
            request({ id: 'ar_1', createdAt: daysAgo(8.5), remindedAt: daysAgo(5), escalatedAt: daysAgo(1) }),
            request({
                id: 'ar_2', requester: { id: 'usr_bo', email: null, displayName: 'Bo' }, createdAt: daysAgo(0),
                bindingId: 'bnd_1', requestedRole: 'workspace_viewer', currentExpiresAt: '2026-10-25T00:00:00Z',
            }),
        ])
        renderPanel()

        const ana = (await screen.findByText('Ana')).closest('li') as HTMLElement
        expect(within(ana).getByText('Waiting 8 days')).toBeInTheDocument()
        expect(within(ana).getByText('Sent to the Org Admins')).toBeInTheDocument()
        const bo = screen.getByText('Bo').closest('li') as HTMLElement
        expect(within(bo).getByText(/asks to keep/)).toHaveTextContent(/ends/)
        expect(within(bo).queryByText(/Waiting \d+ day/)).not.toBeInTheDocument()
    })

    it('says a request is for a service account, what it is for and whose it is', async () => {
        requests.listToAnswer.mockResolvedValue([request({
            id: 'ar_1', requester: { id: 'svc_sync', email: 'svc_sync@service.local', displayName: 'Metadata sync' },
            serviceAccount: {
                description: 'Syncs the catalogue nightly',
                managers: [
                    { type: 'user', name: 'Ana', fromIdp: false },
                    { type: 'group', name: 'Data platform', fromIdp: true },
                ],
            },
            requestedBy: { id: 'usr_ana', email: 'ana@x.io', displayName: 'Ana' },
        })])
        renderPanel()

        const row = (await screen.findByText('Metadata sync')).closest('li') as HTMLElement
        expect(within(row).getByText('Service account')).toBeInTheDocument()
        expect(within(row).queryByText('svc_sync@service.local')).not.toBeInTheDocument()
        expect(within(row).getByText('Service account: Syncs the catalogue nightly')).toBeInTheDocument()
        expect(within(row).getByText(/Managed by Ana, Data platform \(from your identity provider\)/)).toBeInTheDocument()
        expect(within(row).getByText('Asked by Ana')).toBeInTheDocument()
    })

    it('declines with a reason the requester sees', async () => {
        const user = userEvent.setup()
        requests.listToAnswer.mockResolvedValue([request({ id: 'ar_1' })])
        requests.deny.mockResolvedValue(request({ id: 'ar_1', status: 'denied' }))
        renderPanel()
        await user.click(await screen.findByRole('button', { name: /Decline Ana’s request/ }))
        await user.type(screen.getByRole('textbox', { name: 'Reason for declining' }), 'Not this quarter')
        await user.click(screen.getByRole('button', { name: 'Decline' }))
        await waitFor(() => expect(requests.deny).toHaveBeenCalledWith('ar_1', { note: 'Not this quarter' }))
        expect(notify).toHaveBeenCalledWith('success', 'Declined Ana’s request.')
    })

    it('shows how each was answered under All', async () => {
        const user = userEvent.setup()
        requests.listToAnswer.mockImplementation(async ({ status }: { status: string }) => status === 'all'
            ? [request({ id: 'ar_9', status: 'approved', grantedRole: 'workspace_viewer', idpException: true })]
            : [])
        renderPanel()
        expect(await screen.findByText('Nothing waiting')).toBeInTheDocument()
        await user.click(screen.getByRole('radio', { name: 'All' }))
        expect(await screen.findByText(/granted Viewer/)).toBeInTheDocument()
        expect(screen.getByText(/as an exception/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Review/ })).not.toBeInTheDocument()
    })

    it('stays out of the way on a Members tab while nothing waits', async () => {
        requests.listToAnswer.mockResolvedValue([])
        const { container } = renderPanel({ workspaceId: 'ws_fin', hideWhenEmpty: true })
        await waitFor(() => expect(requests.listToAnswer).toHaveBeenCalledWith({ status: 'open', workspaceId: 'ws_fin' }))
        await waitFor(() => expect(container).toBeEmptyDOMElement())
    })
})
