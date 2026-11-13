/**
 * GraphReadModeDialog: one graph's read mode — the platform's default, named, or one of its own —
 * saved through ``PUT …/graphs/{id}/read-mode``. Switch when ready can't be chosen for a customer's
 * own key, and says it is a preview while New-version builds is off; a refusal is shown.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { buildPolicy, setGraphReadMode } = vi.hoisted(() => ({
    buildPolicy: vi.fn(),
    setGraphReadMode: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, buildPolicy, setGraphReadMode } }
})

import { GraphReadModeDialog } from './GraphReadModeDialog'
import type { VersionedGraphRow } from '@/services/systemStatusService'

function row(over: Partial<VersionedGraphRow> = {}): VersionedGraphRow {
    return {
        graphId: 'graph_a', workspaceId: 'ws1', workspaceName: 'Sales', dataSourceId: 'ds1',
        dataSourceLabel: 'Customer 360', providerName: 'Primary', providerType: 'falkordb', kind: 'manual',
        falkorGraphName: 'gvp_a', falkorProvider: 'falkor-eu', committed: 3, projected: 3, target: 3,
        lag: 0, status: 'idle', lastError: null, lastProjectedAt: null, progressDone: null, progressTotal: null,
        updatedAt: null, owned: true, forkParentGraphId: null, orphan: false, retiredKeys: [],
        residency: 'standard', residencyState: 'resident', evictedReason: null, lastReadAt: null,
        sizeBytes: null, rehydratingSince: null, readMode: null, readModeEffective: 'in_place',
        ...over,
    }
}

function policy(readMode = 'in_place', enabled = true) {
    return { values: { readMode: { saved: null, default: readMode, effective: readMode } }, fields: [],
             updatedBy: null, updatedAt: null, enabled }
}

function open(r: VersionedGraphRow, onSaved = vi.fn(), onClose = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><GraphReadModeDialog row={r} onSaved={onSaved} onClose={onClose} /></MemoryRouter>
        </QueryClientProvider>,
    )
    return { onSaved, onClose }
}

beforeEach(() => {
    buildPolicy.mockReset().mockResolvedValue(policy())
    setGraphReadMode.mockReset().mockResolvedValue({ graphId: 'graph_a', readMode: 'latest', readModeEffective: 'latest' })
})

describe('GraphReadModeDialog', () => {
    it("names what the graph's readers get now, and saves a mode of its own", async () => {
        const { onSaved } = open(row())
        expect(screen.getByRole('dialog', { name: 'What readers of Customer 360 get while a new version lands' }))
            .toHaveTextContent('Now: Keep serving, update in place, the platform default.')
        const inherit = await screen.findByRole('radio', { name: /Use the platform default/ })
        expect(inherit).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

        await userEvent.click(screen.getByRole('radio', { name: 'Always the latest' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(setGraphReadMode).toHaveBeenCalledWith('graph_a', 'latest')
        expect(onSaved).toHaveBeenCalledWith({ graphId: 'graph_a', readMode: 'latest', readModeEffective: 'latest' })
    })

    it("gives a graph back the platform's default", async () => {
        open(row({ readMode: 'latest', readModeEffective: 'latest' }))
        await userEvent.click(await screen.findByRole('radio', { name: /Use the platform default/ }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(setGraphReadMode).toHaveBeenCalledWith('graph_a', null)
    })

    it("can't build a customer's own key beside, and says why", async () => {
        open(row({ owned: false }))
        expect(await screen.findByRole('radio', { name: 'Keep serving, switch when ready' })).toBeDisabled()
        expect(screen.getByText(/your own FalkorDB key, which is never copied or built beside/)).toBeInTheDocument()
    })

    it('says switch when ready is a preview while New-version builds is off', async () => {
        buildPolicy.mockResolvedValue(policy('in_place', false))
        open(row())
        expect(await screen.findByText(/Until then this graph updates in place/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Admin → Features' })).toHaveAttribute('href', '/admin/features')
    })

    it('shows what the server refused', async () => {
        setGraphReadMode.mockRejectedValue(Object.assign(new Error('422'), {
            detail: { message: 'this graph is read from your own FalkorDB key' } }))
        const { onSaved } = open(row())
        await userEvent.click(await screen.findByRole('radio', { name: 'Always the latest' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(await screen.findByText('this graph is read from your own FalkorDB key')).toBeInTheDocument()
        expect(onSaved).not.toHaveBeenCalled()
    })
})
