/**
 * The Dashboard for someone with no workspace who can't create one shows
 * the way in — Find a workspace while it is on, whom to ask while it is
 * off — and the requests already on their way.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listMine } = vi.hoisted(() => ({ listMine: vi.fn() }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { listMine },
}))

import { DashboardJoinWorkspace } from './DashboardJoinWorkspace'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <MemoryRouter initialEntries={['/dashboard']}>
            <QueryClientProvider client={client}>
                <Routes>
                    <Route path="/dashboard" element={<DashboardJoinWorkspace />} />
                    <Route path="/workspaces" element={<p>workspaces page</p>} />
                </Routes>
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    listMine.mockResolvedValue([])
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceDirectoryEnabled: true } })
})

describe('DashboardJoinWorkspace', () => {
    it('leads to Find a workspace while it is on', async () => {
        const user = userEvent.setup()
        renderPanel()
        expect(screen.getByText(/You’re not in a workspace yet/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Find a workspace/ }))
        expect(await screen.findByText('workspaces page')).toBeInTheDocument()
    })

    it('says whom to ask while it is off', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        renderPanel()
        expect(screen.queryByRole('button', { name: /Find a workspace/ })).not.toBeInTheDocument()
        expect(screen.getByText(/Ask an administrator to add you/)).toBeInTheDocument()
        expect(screen.getByText('Get a link')).toBeInTheDocument()
    })

    it('shows the requests already on their way', async () => {
        listMine.mockResolvedValue([{
            id: 'ar_1', requester: { id: 'usr_ana', email: null, displayName: null },
            target: { type: 'workspace', id: 'ws_risk', label: 'Risk' }, requestedRole: 'workspace_viewer',
            justification: null, status: 'awaiting_idp', createdAt: '2026-10-18T09:00:00Z',
            resolvedAt: '2026-10-18T10:00:00Z', resolvedBy: 'usr_bob', resolutionNote: null,
            idpGroup: 'risk-analysts', idpProvider: null,
        }])
        renderPanel()
        expect(await screen.findByText('Your requests')).toBeInTheDocument()
        expect(screen.getByText('Waiting on your identity provider')).toBeInTheDocument()
        expect(screen.getByText(/add you to “risk-analysts”/)).toBeInTheDocument()
        expect(listMine).toHaveBeenCalledWith({ status: 'open' })
    })
})
