/**
 * Links to identity-provider groups waiting for a platform administrator: from a
 * workspace admin, or from an approved workspace request. Link (from a chosen
 * connection) or decline with a reason; nobody else sees the queue.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { links } = vi.hoisted(() => ({ links: { list: vi.fn(), link: vi.fn(), decline: vi.fn() } }))
vi.mock('@/services/workspaceGroupsService', () => ({
    idpLinkRequestsService: links, workspaceGroupsService: {}, idpGroupsService: {},
}))
vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: { listProviders: vi.fn().mockResolvedValue([{ id: 'idp_entra', displayName: 'Entra ID' }]) },
}))

import { IdpLinkRequestsPanel } from '../IdpLinkRequestsPanel'
import { useAuthStore } from '@/store/auth'

const request = (over: Record<string, unknown> = {}) => ({
    id: 'ilr_1', groupId: 'grp_eng', groupName: 'Finance Data · Engineers', workspaceId: 'ws_fin', workspaceName: 'Finance Data',
    idpGroup: 'AD-Finance-Eng', providerId: null, requestedBy: 'usr_ada', requestedByName: 'Ada Okafor',
    requestedAt: '2026-11-20T09:00:00Z', status: 'pending', source: 'workspace', seenCount: 4, ...over,
})

function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><IdpLinkRequestsPanel /></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { sid: 's', global: ['system:admin'], ws: {} } } as never)
})

describe('IdpLinkRequestsPanel', () => {
    it('links a group from the connection chosen', async () => {
        links.list.mockResolvedValue([request()])
        links.link.mockResolvedValue(request({ status: 'linked' }))
        renderPanel()
        const row = (await screen.findByText('Finance Data · Engineers')).closest('li')!
        expect(within(row).getByText('AD-Finance-Eng')).toBeInTheDocument()
        expect(within(row).getByText('4 people have it')).toBeInTheDocument()
        expect(within(row).getByText(/Asked by Ada Okafor · Finance Data/)).toBeInTheDocument()
        await userEvent.selectOptions(await within(row).findByRole('combobox', { name: 'Connection for Finance Data · Engineers' }), 'idp_entra')
        await userEvent.click(within(row).getByRole('button', { name: 'Link' }))
        await waitFor(() => expect(links.link).toHaveBeenCalledWith('ilr_1', 'idp_entra'))
    })

    it('declines with a reason', async () => {
        links.list.mockResolvedValue([request({ source: 'workspace_request', seenCount: 0 })])
        links.decline.mockResolvedValue(request({ status: 'declined' }))
        renderPanel()
        const row = (await screen.findByText('Finance Data · Engineers')).closest('li')!
        expect(within(row).getByText('Nobody has signed in with it yet')).toBeInTheDocument()
        expect(within(row).getByText(/From an approved workspace request/)).toBeInTheDocument()
        await userEvent.click(within(row).getByRole('button', { name: 'Decline' }))
        await userEvent.type(within(row).getByRole('textbox', { name: 'Why not link Finance Data · Engineers' }), 'Use AD-Fin instead')
        await userEvent.click(within(row).getByRole('button', { name: 'Decline link' }))
        await waitFor(() => expect(links.decline).toHaveBeenCalledWith('ilr_1', 'Use AD-Fin instead'))
    })

    it('shows nothing to anyone but a platform administrator', async () => {
        useAuthStore.setState({ permissions: { sid: 's', global: ['system:workspaces:create'], ws: {} } } as never)
        links.list.mockResolvedValue([request()])
        renderPanel()
        await new Promise(r => setTimeout(r, 20))
        expect(links.list).not.toHaveBeenCalled()
        expect(screen.queryByText('Identity-provider links to confirm')).not.toBeInTheDocument()
    })
})
