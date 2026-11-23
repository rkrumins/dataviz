/**
 * Asking for data: the wizard walks what and from where, why and by when (and who knows it), and
 * a last look with what happens next, then sends exactly that to the workspace. Nothing goes on
 * until a system is picked and the request has a name; a refusal keeps the wizard open.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ submit: vi.fn() }))
vi.mock('@/services/dataRequestsService', async (orig) => {
    const real = await orig<typeof import('@/services/dataRequestsService')>()
    return { ...real, dataRequestsService: { ...real.dataRequestsService, ...api } }
})
// Steps swap at once (framer-motion's exit never finishes under jsdom).
vi.mock('framer-motion', async (orig) => ({
    ...(await orig<typeof import('framer-motion')>()),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/serviceAccounts/SubjectPicker', () => ({
    subjectKey: (s: { type: string; id: string }) => `${s.type}:${s.id}`,
    SubjectPicker: ({ onPick }: { onPick: (s: { type: string; id: string; name: string; detail: string }) => void }) => (
        <button type="button" onClick={() => onPick({ type: 'user', id: 'usr_ada', name: 'Ada Okafor', detail: 'ada@example.com' })}>
            pick Ada
        </button>
    ),
}))

import { AskForDataWizard } from '../AskForDataWizard'
import { useAuthStore } from '@/store/auth'

function renderWizard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <AskForDataWizard workspace={{ id: 'ws_fin', name: 'Finance' }} onClose={onClose} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { onClose }
}

const next = () => userEvent.click(screen.getByRole('button', { name: /^Next/ }))

beforeEach(() => {
    api.submit.mockReset().mockResolvedValue({ id: 'dr_1' })
    useAuthStore.setState({ user: { id: 'usr_me', firstName: 'Sam', lastName: 'Reader', email: 'sam@example.com' } } as never)
})

describe('AskForDataWizard', () => {
    it('walks the three steps and sends what was chosen', async () => {
        const user = userEvent.setup()
        renderWizard()
        expect(screen.getByRole('heading', { name: 'What data do you need?' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^Next/ })).toBeDisabled()          // a system and a name first
        await user.click(screen.getByRole('radio', { name: /Snowflake/ }))
        expect(screen.getByRole('radio', { name: /Snowflake/ })).toHaveAttribute('aria-checked', 'true')
        // The hints speak the system's language.
        expect(screen.getByRole('textbox', { name: 'What exactly?' })).toHaveAttribute('placeholder', expect.stringContaining('FIN_DB.MARTS'))
        expect(screen.getByRole('button', { name: /^Next/ })).toBeDisabled()
        await user.type(screen.getByRole('textbox', { name: 'A short name for it' }), 'Finance marts')
        await user.type(screen.getByRole('textbox', { name: 'What exactly?' }), 'gl_balances and ap_invoices')
        await next()

        expect(screen.getByRole('heading', { name: 'What’s it for, and by when?' })).toBeInTheDocument()
        await user.type(screen.getByRole('textbox', { name: 'What will you use it for?' }), 'The March audit')
        await user.click(screen.getByRole('radio', { name: /This week/ }))
        await user.click(screen.getByRole('button', { name: 'pick Ada' }))
        expect(screen.getByText('Ada Okafor')).toBeInTheDocument()
        await next()

        expect(screen.getByRole('heading', { name: 'Ready to send?' })).toBeInTheDocument()
        expect(screen.getByText('From Snowflake · for Finance')).toBeInTheDocument()
        expect(screen.getByText('gl_balances and ap_invoices')).toBeInTheDocument()
        expect(screen.getByText('What happens next')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Send request/ }))
        expect(api.submit).toHaveBeenCalledWith('ws_fin', {
            title: 'Finance marts', system: 'snowflake', details: 'gl_balances and ap_invoices', purpose: 'The March audit',
            urgency: 'this_week', contactIds: ['usr_ada'],
        })
        expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Track it/ })).toBeInTheDocument()
    })

    it('keeps the wizard open with what was written when sending fails', async () => {
        const user = userEvent.setup()
        api.submit.mockRejectedValueOnce(new Error('Asking for data is turned off for this deployment.'))
        renderWizard()
        await user.click(screen.getByRole('radio', { name: /A file/ }))
        await user.type(screen.getByRole('textbox', { name: 'A short name for it' }), 'Inventory')
        await next(); await next()
        await user.click(screen.getByRole('button', { name: /Send request/ }))
        expect(await screen.findByRole('heading', { name: 'Ready to send?' })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Request sent' })).toBeNull()
    })
})
