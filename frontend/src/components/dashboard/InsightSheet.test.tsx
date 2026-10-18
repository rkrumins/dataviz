/**
 * What is behind a Dashboard number: sources ranked by size with how each is
 * doing, a refresh for whoever runs them, and the estate's trend — the
 * summary's figures, never a second count.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSummary } from '@/services/workspaceService'

const { refreshSource, notify } = vi.hoisted(() => ({ refreshSource: vi.fn(), notify: vi.fn() }))
vi.mock('@/services/freshnessService', () => ({ freshnessService: { refreshSource } }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import { InsightSheet } from './InsightSheet'

const SUMMARY: WorkspaceSummary = {
    coverage: 'all',
    totals: {
        workspaces: 2, dataSources: 3, activeDataSources: 2, pendingDataSources: 1,
        nodes: 1200, edges: 300, entityTypes: [], views: 5, sharedGraphs: 1,
    },
    workspaces: [
        {
            id: 'ws_fin', name: 'Finance', isDefault: true, dataSources: 2, activeDataSources: 2, pendingDataSources: 1,
            nodes: 1000, edges: 250, entityTypes: [], views: 4,
            sources: {
                ds_big: { nodes: 1000, edges: 250, pending: false, views: 3 },
                ds_cold: { nodes: 0, edges: 0, pending: true, views: 1 },
            },
        },
        {
            id: 'ws_ops', name: 'Operations', isDefault: false, dataSources: 1, activeDataSources: 0, pendingDataSources: 0,
            nodes: 200, edges: 50, entityTypes: [], views: 1,
            sources: { ds_small: { nodes: 200, edges: 50, pending: false, views: 1 } },
        },
    ],
}

function renderSheet(kind: 'sources' | 'workspaces') {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MotionConfig reducedMotion="always">
                <MemoryRouter>
                    <InsightSheet kind={kind} onClose={vi.fn()} summary={SUMMARY} ontologies={[]} />
                </MemoryRouter>
            </MotionConfig>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacesStore.setState({
        workspaces: [
            { id: 'ws_fin', name: 'Finance', dataSources: [
                { id: 'ds_big', label: 'Warehouse', isActive: true },
                { id: 'ds_cold', label: 'New lake', isActive: true },
            ] },
            { id: 'ws_ops', name: 'Operations', dataSources: [{ id: 'ds_small', label: 'Tickets', isActive: false }] },
        ],
    } as never)
    useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:datasource:manage'] } } } as never)
})

describe('InsightSheet', () => {
    it('ranks sources by size and says which are still counting or paused', () => {
        renderSheet('sources')
        const sheet = screen.getByRole('dialog', { name: 'Data Sources' })
        expect(within(sheet).getByText('3')).toBeInTheDocument()
        const names = within(sheet).getAllByText(/Warehouse|Tickets|New lake/).map(n => n.textContent)
        expect(names).toEqual(['Warehouse', 'Tickets', 'New lake'])
        expect(within(sheet).getByText('Counting…')).toBeInTheDocument()
        expect(within(sheet).getByText('Paused')).toBeInTheDocument()
        expect(within(sheet).getByText(/counted once in the totals/)).toBeInTheDocument()
    })

    it('offers a refresh only where the caller runs the sources, and re-reads the summary', async () => {
        refreshSource.mockResolvedValue({})
        renderSheet('sources')
        expect(screen.queryByRole('button', { name: 'Refresh the numbers for Tickets' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Refresh the numbers for Warehouse' }))
        await waitFor(() => expect(refreshSource).toHaveBeenCalledWith('ds_big', expect.objectContaining({ scope: 'read-caches' })))
        expect(notify).toHaveBeenCalledWith('success', 'Refreshing the numbers for Warehouse')
    })

    it('ranks workspaces by size and links to each', () => {
        renderSheet('workspaces')
        const links = within(screen.getByRole('dialog', { name: 'Workspaces' })).getAllByRole('link')
        expect(links[0]).toHaveAttribute('href', '/workspaces/ws_fin')
        expect(links[1]).toHaveAttribute('href', '/workspaces/ws_ops')
        expect(links[0]).toHaveTextContent('2 sources · 4 views')
    })
})
