/**
 * AddDataSourceWizard — pulling in a source that has views built on it.
 *
 * Such a source can only move with its views, which needs admin rights in
 * both workspaces and the move wizard's access decisions. So for someone who
 * runs both, the picker offers it ("Move with N views") and hands it over;
 * for anyone else it stays disabled, saying its admins can move it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderResponse } from '@/services/providerService'

const { admins } = vi.hoisted(() => ({ admins: { of: [] as string[] } }))

const BOUND = {
    id: 'c_orders', providerId: 'p1', name: 'orders', sourceIdentifier: 'orders_graph',
    boundWorkspaceId: 'ws_fin', boundWorkspaceName: 'Finance', boundDataSourceId: 'ds_orders', boundViewCount: 3,
}

vi.mock('@/services/catalogService', () => ({ catalogService: { listWithBindings: () => Promise.resolve([BOUND]) } }))
vi.mock('@/components/dataSource/NodeIdentity', () => ({
    NodeIdentityField: () => null, isIdentityOverridden: () => false, isNameOverridden: () => false,
}))
vi.mock('@/store/auth', () => ({
    useAuthStore: (selector: (s: unknown) => unknown) => selector({
        can: (perm: string, ws?: string) => perm === 'workspace:admin' && !!ws && admins.of.includes(ws),
    }),
}))

import { AddDataSourceWizard } from '../AddDataSourceWizard'

function renderWizard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onMoveWithViews = vi.fn()
    const onClose = vi.fn()
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <AddDataSourceWizard isOpen workspaceId="ws_risk" workspaceName="Risk" onClose={onClose} onAdded={vi.fn()}
                    catalogItems={[]} providers={[{ id: 'p1', name: 'Falkor', providerType: 'falkordb' } as ProviderResponse]}
                    ontologies={[]} onMoveWithViews={onMoveWithViews} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { onMoveWithViews, onClose }
}

beforeEach(() => { admins.of = [] })

describe('AddDataSourceWizard — a source with views', () => {
    it('hands it to the move wizard for someone who runs both workspaces', async () => {
        admins.of = ['ws_fin', 'ws_risk']
        const { onMoveWithViews, onClose } = renderWizard()

        fireEvent.click(await screen.findByText('1 source can be moved here'))
        fireEvent.click(screen.getByText('Move with 3 views'))

        expect(onClose).toHaveBeenCalled()
        expect(onMoveWithViews).toHaveBeenCalledWith(expect.objectContaining({
            boundWorkspaceId: 'ws_fin', boundDataSourceId: 'ds_orders',
        }))
    })

    it('leaves it disabled for everyone else, saying who can move it', async () => {
        admins.of = ['ws_risk']
        const { onMoveWithViews } = renderWizard()

        fireEvent.click(await screen.findByText(/Show 1 source allocated to other workspaces/))
        expect(screen.getByText('Used by Finance · 3 views built on it · its admins can move it')).toBeInTheDocument()
        expect(screen.queryByText('Move with 3 views')).not.toBeInTheDocument()
        expect(onMoveWithViews).not.toHaveBeenCalled()
    })
})
