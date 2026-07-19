/**
 * Freshness cockpit — the tab renders a mocked fleet payload and its row
 * actions fire the unified refresh verb with the right scope.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { listFleet, refreshSource, listProviders, listWorkspaces } = vi.hoisted(() => ({
    listFleet: vi.fn(),
    refreshSource: vi.fn(),
    listProviders: vi.fn(),
    listWorkspaces: vi.fn(),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            listFleet,
            refreshSource,
        },
    }
})
vi.mock('@/services/providerService', () => ({ providerService: { list: listProviders } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: listWorkspaces } }))

// jsdom lacks the pointer-capture + scroll APIs Radix calls when a menu opens.
beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
})

import { Freshness } from './index'

const recent = new Date(Date.now() - 5 * 60_000).toISOString()

const fleet = {
    total: 2,
    rows: [
        {
            dataSourceId: 'ds-1', workspaceId: 'ws-1', providerId: 'prov-1',
            name: 'Orders Graph', providerName: 'Warehouse',
            aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent,
            generation: 4, staleReason: 'source_changed', drifted: null, runningJobId: null,
            lastEvent: { origin: 'api', outcome: 'accepted', ts: recent },
        },
        {
            dataSourceId: 'ds-2', workspaceId: 'ws-1', providerId: 'prov-1',
            name: 'Customers Graph', providerName: 'Warehouse',
            aggregationStatus: 'ready', lastAggregatedAt: recent, cacheAsOf: recent,
            generation: 2, staleReason: null, drifted: null, runningJobId: null,
            lastEvent: null,
        },
    ],
}

function renderTab() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><Freshness /></QueryClientProvider>)
}

describe('Freshness cockpit', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        listFleet.mockResolvedValue(fleet)
        refreshSource.mockResolvedValue({ scope: 'read-caches', gate: 'n/a', changed: true, actions: [], deferred: false })
        listProviders.mockResolvedValue([{ id: 'prov-1', name: 'Warehouse' }])
        listWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Analytics' }])
    })

    it('renders fleet rows with cache age and the Recomputing badge', async () => {
        renderTab()

        await waitFor(() => {
            expect(screen.getByText('Orders Graph')).toBeInTheDocument()
        })
        expect(screen.getByText('Customers Graph')).toBeInTheDocument()
        // "as of Xm ago" cache chips are present.
        expect(screen.getAllByText(/as of/i).length).toBeGreaterThan(0)
        // Only the source_changed row shows the Recomputing badge.
        expect(screen.getByText('Recomputing')).toBeInTheDocument()
    })

    it('fires read-caches immediately from the row action menu', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        await user.click(screen.getByRole('button', { name: /refresh actions for orders graph/i }))
        await user.click(await screen.findByText('Refresh caches'))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'read-caches' }))
        })
    })

    it('confirms before a lineage rebuild, then fires the rollups scope', async () => {
        const user = userEvent.setup()
        renderTab()

        await waitFor(() => expect(screen.getByText('Orders Graph')).toBeInTheDocument())

        await user.click(screen.getByRole('button', { name: /refresh actions for orders graph/i }))
        await user.click(await screen.findByText('Rebuild lineage'))

        // A confirm dialog gates the rebuild — no mutation yet.
        expect(refreshSource).not.toHaveBeenCalled()
        const dialog = await screen.findByRole('dialog')
        await user.click(within(dialog).getByRole('button', { name: /rebuild lineage/i }))

        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-1', expect.objectContaining({ scope: 'rollups' }))
        })
    })
})
