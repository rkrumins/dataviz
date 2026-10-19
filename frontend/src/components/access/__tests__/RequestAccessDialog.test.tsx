/**
 * Request access: the levels a workspace lets people ask for, in plain
 * language (one you hold isn't offered), the workspace's note above your
 * reason, what happens next — said differently where the identity provider
 * decides — and the request sent with what you chose.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { service } = vi.hoisted(() => ({
    service: { requestableRoles: vi.fn(), submit: vi.fn() },
}))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: service }))

import { RequestAccessDialog, type RequestAccessDialogProps } from '../RequestAccessDialog'

const ROLES = [
    { name: 'workspace_viewer', description: 'Read-only', isSystem: true },
    { name: 'workspace_member', description: 'Contributor', isSystem: true },
    { name: 'finance_auditor', description: 'Reads the ledgers', isSystem: false },
]

function renderDialog(props: Partial<RequestAccessDialogProps> = {}) {
    const onClose = vi.fn()
    const onSent = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <MemoryRouter>
            <QueryClientProvider client={client}>
                <RequestAccessDialog workspaceId="ws_fin" onClose={onClose} onSent={onSent} {...props} />
            </QueryClientProvider>
        </MemoryRouter>,
    )
    return { onClose, onSent }
}

const REQUEST = {
    id: 'ar_1', requester: { id: 'usr_ana', email: null, displayName: null },
    target: { type: 'workspace' as const, id: 'ws_fin', label: 'Finance' },
    requestedRole: 'workspace_member', justification: 'Close team', status: 'pending' as const,
    createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null, resolutionNote: null,
}

beforeEach(() => {
    vi.clearAllMocks()
    service.requestableRoles.mockResolvedValue(ROLES)
    service.submit.mockResolvedValue(REQUEST)
})

describe('RequestAccessDialog', () => {
    it('offers the levels in plain language, never one you already hold', async () => {
        renderDialog({ workspaceName: 'Finance', heldRoles: ['workspace_viewer'] })

        expect(screen.getByRole('dialog', { name: 'Ask to join Finance' })).toBeInTheDocument()
        const view = await screen.findByRole('radio', { name: /View/ })
        expect(view).toBeDisabled()
        expect(view).toHaveTextContent('You already have this.')
        // The first level not held is chosen for you.
        expect(screen.getByRole('radio', { name: /Contribute/ })).toHaveAttribute('aria-checked', 'true')
        // A custom role reads as its own name and description.
        expect(screen.getByRole('radio', { name: /finance_auditor/ })).toHaveTextContent('Reads the ledgers')
        expect(service.requestableRoles).toHaveBeenCalledWith('ws_fin')
    })

    it('sends the level and reason chosen, and says what happens next', async () => {
        const user = userEvent.setup()
        const { onSent } = renderDialog({ workspaceName: 'Finance', accessNote: 'Say which team you’re on' })

        expect(screen.getByText('Say which team you’re on')).toBeInTheDocument()
        expect(screen.getByText('They approve it, or say why not')).toBeInTheDocument()
        await user.click(await screen.findByRole('radio', { name: /finance_auditor/ }))
        await user.type(screen.getByRole('textbox'), 'Quarter-end audit')
        await user.click(screen.getByRole('button', { name: 'Send request' }))

        await waitFor(() => expect(service.submit).toHaveBeenCalledWith({
            targetType: 'workspace', targetId: 'ws_fin',
            requestedRole: 'finance_auditor', justification: 'Quarter-end audit',
        }))
        expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Follow it on My access/ })).toHaveAttribute('href', '/my/access')
        expect(onSent).toHaveBeenCalledWith(REQUEST)
    })

    it('says up front when the identity provider decides who is in', async () => {
        renderDialog({ accessMode: 'idp' })
        expect(screen.getByRole('dialog', { name: 'Ask to join this workspace' })).toBeInTheDocument()
        expect(screen.getByText('Your identity provider decides who is in')).toBeInTheDocument()
        expect(screen.getByText(/access arrives the next time you sign in/)).toBeInTheDocument()
    })

    it('shows the server’s answer when the request is refused', async () => {
        const user = userEvent.setup()
        service.submit.mockRejectedValue(new Error('You already have this access'))
        renderDialog()
        await user.click(await screen.findByRole('button', { name: 'Send request' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('You already have this access')
    })

    it('explains a workspace that can’t take requests', async () => {
        service.requestableRoles.mockRejectedValue(new Error('Workspace not found'))
        renderDialog()
        expect(await screen.findByRole('alert')).toHaveTextContent(/doesn’t exist any more/)
        expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
    })
})
