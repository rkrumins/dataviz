/**
 * Asking for a workspace: the wizard walks what it's for, who's in it, what comes from the
 * Playground and a last look, then sends exactly that. A taken name comes back with a free one to
 * use; a request sent back opens with the platform team's question and needs an answer; the draft
 * survives closing the wizard.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'

const api = vi.hoisted(() => ({ submit: vi.fn(), resubmit: vi.fn() }))
vi.mock('@/services/workspaceRequestsService', async (orig) => {
    const real = await orig<typeof import('@/services/workspaceRequestsService')>()
    return { ...real, workspaceRequestsService: { ...real.workspaceRequestsService, ...api } }
})
vi.mock('@/services/viewApiService', () => ({
    listViews: vi.fn().mockResolvedValue({ items: [{ id: 'v1', dataSourceId: 'ds_mine' }, { id: 'v2', dataSourceId: 'ds_mine' }] }),
}))
// Steps swap at once (framer-motion's exit never finishes under jsdom).
vi.mock('framer-motion', async (orig) => ({
    ...(await orig<typeof import('framer-motion')>()),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: { enabled: true, exists: true } }) }))
vi.mock('@/components/serviceAccounts/SubjectPicker', () => ({
    subjectKey: (s: { type: string; id: string }) => `${s.type}:${s.id}`,
    SubjectPicker: ({ onPick }: { onPick: (s: { type: string; id: string; name: string; detail: string }) => void }) => (
        <button type="button" onClick={() => onPick({ type: 'user', id: 'usr_ada', name: 'Ada Okafor', detail: 'ada@example.com' })}>
            pick Ada
        </button>
    ),
}))

import { RequestWorkspaceWizard } from '../RequestWorkspaceWizard'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

function renderWizard(props: Partial<React.ComponentProps<typeof RequestWorkspaceWizard>> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    const view = render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <RequestWorkspaceWizard onClose={onClose} {...props} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { ...view, onClose }
}

const next = () => userEvent.click(screen.getByRole('button', { name: /^Next/ }))

beforeEach(() => {
    api.submit.mockReset().mockResolvedValue({ id: 'wsr_1' })
    api.resubmit.mockReset().mockResolvedValue({ id: 'wsr_1' })
    window.localStorage.clear()
    useAuthStore.setState({ user: { id: 'usr_me', firstName: 'Sam', lastName: 'Reader', email: 'sam@example.com' } } as never)
    useWorkspacesStore.setState({
        workspaces: [{
            id: 'ws_play', name: 'Playground', kind: 'playground',
            dataSources: [
                { id: 'ds_mine', label: 'Supply chain sketch', createdBy: 'usr_me' },
                { id: 'ds_theirs', label: 'Not mine', createdBy: 'usr_ada' },
            ],
        }],
    } as never)
})

describe('RequestWorkspaceWizard', () => {
    it('walks the four steps and sends what was chosen', async () => {
        const user = userEvent.setup()
        renderWizard()
        expect(screen.getByRole('button', { name: /^Next/ })).toBeDisabled()   // a name first
        await user.click(screen.getByRole('radio', { name: /A proof of concept/ }))
        await user.type(screen.getByRole('textbox', { name: 'Name' }), 'ML lineage')
        await next()

        expect(screen.getByRole('heading', { name: 'Who’s it for?' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'pick Ada' }))
        expect(screen.getByText('Ada Okafor')).toBeInTheDocument()
        await next()

        const mine = await screen.findByRole('checkbox', { name: /Supply chain sketch/ })
        expect(screen.queryByText('Not mine')).toBeNull()             // only the reader's own graphs
        expect(await within(mine).findByText(/2 views/)).toBeInTheDocument()
        await user.click(mine)
        await next()

        expect(screen.getByRole('heading', { name: 'Ready to send?' })).toBeInTheDocument()
        expect(screen.getByText(/Supply chain sketch \(2 views\)/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Send request/ }))
        expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({
            name: 'ML lineage', purpose: 'poc', teammateIds: ['usr_ada'], playgroundSourceIds: ['ds_mine'],
        }))
        expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument()
    })

    it('brings a taken name back to the first step, with a free one to use', async () => {
        const user = userEvent.setup()
        api.submit.mockRejectedValueOnce(Object.assign(new Error('taken'), {
            status: 409, detail: { type: 'name_taken', message: 'taken', suggestion: 'Finance 2' },
        }))
        renderWizard()
        await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Finance')
        await next(); await next(); await next()
        await user.click(screen.getByRole('button', { name: /Send request/ }))
        expect(await screen.findByRole('alert')).toHaveTextContent('A workspace already has that name.')
        await user.click(screen.getByRole('button', { name: 'Use “Finance 2”' }))
        expect(screen.getByDisplayValue('Finance 2')).toBeInTheDocument()
    })

    it('opens a request sent back with the question, and wants an answer before resending', async () => {
        const user = userEvent.setup()
        const editing = {
            id: 'wsr_9', requesterId: 'usr_me', name: 'Billing', purpose: 'project', teammateIds: [], playgroundSourceIds: [],
            status: 'changes_requested', question: 'Who owns it after the project?', createdAt: '2026-11-18T00:00:00Z',
        } as unknown as WorkspaceRequest
        renderWizard({ editing })
        expect(screen.getByText('Who owns it after the project?')).toBeInTheDocument()
        await next(); await next(); await next()
        const resend = screen.getByRole('button', { name: /Send it back/ })
        expect(resend).toBeDisabled()
        await user.type(screen.getByRole('textbox', { name: 'Reply to the platform team' }), 'The data team')
        await user.click(resend)
        expect(api.resubmit).toHaveBeenCalledWith('wsr_9', expect.objectContaining({ name: 'Billing', note: 'The data team' }))
    })

    it('keeps the draft when the wizard is closed', async () => {
        const user = userEvent.setup()
        const { unmount } = renderWizard()
        await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Half-written')
        unmount()
        renderWizard()
        expect(screen.getByDisplayValue('Half-written')).toBeInTheDocument()
    })
})
