/**
 * "Preview with real data": nothing is read until it is opened; then a few
 * real entities land in the layers a view built from the template would put
 * them in, with how many there are in all, and what the data doesn't declare
 * is said.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeQuery } from '@/providers/GraphDataProvider'
import type { ViewLayerConfig } from '@/types/schema'

const { getNodesPage, wsState } = vi.hoisted(() => ({
    getNodesPage: vi.fn(),
    wsState: {
        activeWorkspaceId: 'ws_fin',
        workspaces: [{ id: 'ws_fin', name: 'Finance', dataSources: [{ id: 'ds_fin', isPrimary: true }] }] as unknown[],
    },
}))

vi.mock('@/providers/providerPool', () => ({ getOrCreateProvider: () => ({ getNodesPage }) }))
vi.mock('@/hooks/useWorkspaceEntityTypes', () => ({
    useWorkspaceEntityTypes: () => ({ types: ['Table', 'Dashboard'], isLoading: false, isError: false }),
}))
vi.mock('@/store/workspaces', () => {
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof wsState) => unknown) => selector(wsState),
        { getState: () => wsState },
    )
    return { useWorkspacesStore }
})

import { useAuthStore } from '@/store/auth'
import { TemplateLivePreview } from '../TemplateLivePreview'

const LAYERS: ViewLayerConfig[] = [
    { id: 'src', name: 'Sources', color: '#3b82f6', entityTypes: ['table'], order: 0 },
    { id: 'rep', name: 'Reports', entityTypes: ['Dashboard', 'Chart'], order: 1 },
    { id: 'man', name: 'Curated', entityTypes: [], order: 2 },
]

function renderPreview() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <TemplateLivePreview layers={LAYERS} />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:datasource:read'] } } } as never)
    getNodesPage.mockImplementation(async ({ entityTypes }: NodeQuery) => {
        const type = entityTypes![0]
        const names = type === 'Table' ? ['orders', 'payments'] : ['revenue']
        return {
            nodes: names.map(n => ({ urn: `urn:${type}:${n}`, entityType: type, displayName: n, properties: {}, tags: [] })),
            hasMore: true, nextOffset: names.length, totalCount: type === 'Table' ? 1204 : 31,
        }
    })
})

describe('TemplateLivePreview', () => {
    it('reads nothing until it is opened', () => {
        renderPreview()
        expect(screen.getByRole('button', { name: /preview with real data/i })).toHaveAttribute('aria-expanded', 'false')
        expect(getNodesPage).not.toHaveBeenCalled()
    })

    it('fills each layer with real entities, matched to the data', async () => {
        renderPreview()
        fireEvent.click(screen.getByRole('button', { name: /preview with real data/i }))

        const sources = await screen.findByRole('group', { name: 'Sources' })
        await waitFor(() => expect(within(sources).getByText('orders')).toBeInTheDocument())
        expect(within(sources).getByText('payments')).toBeInTheDocument()
        expect(within(sources).getByText('Table: 2 of ~1,204')).toBeInTheDocument()

        const reports = screen.getByRole('group', { name: 'Reports' })
        expect(within(reports).getByText('revenue')).toBeInTheDocument()
        expect(within(screen.getByRole('group', { name: 'Curated' })).getByText('Filled by hand in each view')).toBeInTheDocument()

        expect(getNodesPage).toHaveBeenCalledWith({ entityTypes: ['Table'], limit: 6 })
        expect(getNodesPage).not.toHaveBeenCalledWith(expect.objectContaining({ entityTypes: ['Chart'] }))
        expect(screen.getByText(/matches 2 of 2 layers/)).toBeInTheDocument()
        expect(screen.getByText(/Not in Finance's semantic layer: Chart/)).toBeInTheDocument()
    })

    it('says so when the data cannot be read, and keeps the template', async () => {
        getNodesPage.mockRejectedValue(new Error('engine down'))
        renderPreview()
        fireEvent.click(screen.getByRole('button', { name: /preview with real data/i }))
        // After the one retry a passing blip gets.
        expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent("Couldn't read entities from Finance")
    })

    it('stays out of the way without data to read', () => {
        useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
        renderPreview()
        expect(screen.queryByRole('button', { name: /preview with real data/i })).not.toBeInTheDocument()
    })
})
