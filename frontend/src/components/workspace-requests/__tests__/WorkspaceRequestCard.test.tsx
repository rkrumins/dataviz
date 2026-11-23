/**
 * Where a workspace request stands, and the way to ask for one: a question sent back opens the
 * wizard to answer it, an approved request opens the workspace, a declined one says why — and with
 * no request, the invitation. None of it shows for someone who creates workspaces themselves, or
 * while requests are off.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'

const api = vi.hoisted(() => ({ listMine: vi.fn(), withdraw: vi.fn() }))
vi.mock('@/services/workspaceRequestsService', async (orig) => {
    const real = await orig<typeof import('@/services/workspaceRequestsService')>()
    return { ...real, workspaceRequestsService: { ...real.workspaceRequestsService, ...api } }
})

import { WorkspaceRequestPrompt, latestRequest } from '../WorkspaceRequestCard'
import { useRequestWorkspaceWizard } from '@/hooks/useWorkspaceRequests'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const req = (over: Partial<WorkspaceRequest>) => ({
    id: 'wsr_1', requesterId: 'usr_me', name: 'ML lineage', purpose: 'poc', teammateIds: [], playgroundSourceIds: [],
    status: 'pending', createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), ...over,
}) as WorkspaceRequest

function renderPrompt() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/dashboard']}>
                <Routes>
                    <Route path="/dashboard" element={<WorkspaceRequestPrompt preselectedSourceIds={['ds_1']} />} />
                    <Route path="/workspaces/:id" element={<p>the new workspace</p>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    api.listMine.mockReset().mockResolvedValue([])
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceRequestsEnabled: true } })
    useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
    useRequestWorkspaceWizard.setState({ open: false, editing: null, preselectedSourceIds: [] })
})

describe('WorkspaceRequestPrompt', () => {
    it('invites someone with no request to ask, bringing their Playground graphs', async () => {
        const user = userEvent.setup()
        renderPrompt()
        await user.click(await screen.findByRole('button', { name: /Request a workspace/ }))
        expect(useRequestWorkspaceWizard.getState()).toMatchObject({ open: true, preselectedSourceIds: ['ds_1'] })
    })

    it('shows a waiting request with how long it has waited', async () => {
        api.listMine.mockResolvedValue([req({})])
        renderPrompt()
        expect(await screen.findByText('ML lineage')).toBeInTheDocument()
        expect(screen.getByText(/Waiting 4 days/)).toBeInTheDocument()
    })

    it('puts the platform team’s question first, and answering opens the wizard on it', async () => {
        const user = userEvent.setup()
        const asked = req({ status: 'changes_requested', question: 'Who owns it later?' })
        api.listMine.mockResolvedValue([asked])
        renderPrompt()
        expect(await screen.findByText('Who owns it later?')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Answer & resend/ }))
        expect(useRequestWorkspaceWizard.getState()).toMatchObject({ open: true, editing: asked })
    })

    it('opens the workspace once it is approved', async () => {
        const user = userEvent.setup()
        api.listMine.mockResolvedValue([req({ status: 'approved', workspaceId: 'ws_new', resolvedAt: new Date().toISOString() })])
        renderPrompt()
        await user.click(await screen.findByRole('button', { name: /Open it/ }))
        expect(screen.getByText('the new workspace')).toBeInTheDocument()
    })

    it('says why it was declined, and lets them ask again', async () => {
        api.listMine.mockResolvedValue([req({ status: 'declined', resolutionNote: 'Finance Data covers it', resolvedAt: new Date().toISOString() })])
        renderPrompt()
        expect(await screen.findByText(/Finance Data covers it/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument()
    })

    it('is not there for someone who creates workspaces, or while requests are off', async () => {
        useAuthStore.setState({ permissions: { global: ['system:workspaces:create'], ws: {} } } as never)
        const { unmount } = renderPrompt()
        await new Promise(r => setTimeout(r, 20))
        expect(screen.queryByRole('button', { name: /Request a workspace/ })).not.toBeInTheDocument()
        unmount()
        api.listMine.mockClear()
        useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceRequestsEnabled: false } })
        renderPrompt()
        await new Promise(r => setTimeout(r, 20))
        expect(screen.queryByRole('button', { name: /Request a workspace/ })).not.toBeInTheDocument()
        expect(api.listMine).not.toHaveBeenCalled()
    })
})

describe('latestRequest', () => {
    it('prefers an open request, then one answered in the last fortnight', () => {
        const old = req({ id: 'a', status: 'approved', resolvedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })
        const recent = req({ id: 'b', status: 'declined', resolvedAt: new Date().toISOString() })
        expect(latestRequest([old])).toBeNull()
        expect(latestRequest([old, recent])?.id).toBe('b')
        expect(latestRequest([recent, req({ id: 'c' })])?.id).toBe('c')
    })
})
