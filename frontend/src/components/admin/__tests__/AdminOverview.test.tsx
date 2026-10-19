/**
 * Global Overview quotes the workspace summary — the same server-side numbers as
 * the Dashboard — and never turns a failed request into a fleet of zeros.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminOverview } from '../AdminOverview'

const { summary } = vi.hoisted(() => ({ summary: vi.fn() }))

vi.mock('@/services/workspaceService', () => ({ workspaceService: { summary } }))
vi.mock('@/services/providerService', () => ({
    providerService: { list: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]) },
}))

function renderOverview() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter><AdminOverview /></MemoryRouter>
        </QueryClientProvider>,
    )
}

// Braces matter: a function returned from beforeEach runs as its teardown.
beforeEach(() => { summary.mockReset() })

describe('AdminOverview', () => {
    it('shows the summary’s totals, a graph shared by workspaces counted once', async () => {
        summary.mockResolvedValue({
            coverage: 'all',
            totals: {
                workspaces: 2, dataSources: 4, activeDataSources: 4, pendingDataSources: 1,
                nodes: 1_500, edges: 300, entityTypes: ['Column', 'Table'], views: 9, sharedGraphs: 1,
            },
            workspaces: [{
                id: 'ws_fin', name: 'Finance', isDefault: true, dataSources: 2, activeDataSources: 2,
                pendingDataSources: 1, nodes: 1_500, edges: 300, entityTypes: ['Table'], views: 9, sources: {},
            }],
        })
        renderOverview()

        expect(await screen.findByText('Finance')).toBeInTheDocument()
        // Total Nodes reads 1.5k here and on the Dashboard — one formatter.
        expect(screen.getAllByText('1.5k').length).toBeGreaterThan(0)
        expect(screen.getByText(/counted once in the totals/)).toBeInTheDocument()
        expect(screen.getByText(/totals fill in on their own/)).toBeInTheDocument()
        expect(screen.getByText('Column')).toBeInTheDocument()
    })

    it('says the counts are unknown when the summary fails, instead of showing zeros', async () => {
        summary.mockRejectedValue(new Error('boom'))
        renderOverview()
        expect(await screen.findByRole('alert')).toHaveTextContent('unknown, not zero')
        expect(screen.queryByText('0')).not.toBeInTheDocument()
    })
})
