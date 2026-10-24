/**
 * Moving one versioned graph's read cache to another FalkorDB provider or
 * key, from its row on Admin → Infrastructure: the dialog offers only the
 * active FalkorDB providers, says what the move costs before it happens,
 * offers a move back onto a key the graph is still retiring, and turns the
 * server's refusals into what the administrator can do about them.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { moveProjection } = vi.hoisted(() => ({ moveProjection: vi.fn() }))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, moveProjection } }
})

import { MoveProjectionDialog } from './MoveProjectionDialog'
import type { GraphProvider, VersionedGraphRow } from '@/services/systemStatusService'

const PROVIDERS: GraphProvider[] = [
    { id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true },
    { id: 'falkor-us', name: 'US graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true },
    { id: 'falkor-old', name: 'Old graph store', type: 'falkordb', status: 'down', error: null, isActive: false },
    { id: 'neo', name: 'Neo4j', type: 'neo4j', status: 'healthy', error: null, isActive: true },
]

const ROW: VersionedGraphRow = {
    graphId: 'graph_b', workspaceId: 'ws1', workspaceName: 'Sales', dataSourceId: 'ds1',
    dataSourceLabel: 'Customer 360', providerName: 'Primary', providerType: 'falkordb', kind: 'manual',
    falkorGraphName: 'gvt_graph_b', falkorProvider: 'falkor-eu', committed: 3, projected: 3, target: 3,
    lag: 0, status: 'idle', lastError: null, lastProjectedAt: null, progressDone: null, progressTotal: null,
    updatedAt: null, owned: true, forkParentGraphId: null, orphan: false, retiredKeys: [],
}

const MOVED = {
    graphId: 'graph_b', changed: true,
    from: { providerId: 'falkor-eu', key: 'gvt_graph_b' },
    to: { providerId: 'falkor-us', key: 'gvp_graph_b{graph_b.1}' },
    retiring: null, watermark: {},
}

function renderDialog(row: VersionedGraphRow = ROW) {
    const onMoved = vi.fn()
    const onClose = vi.fn()
    render(<MoveProjectionDialog row={row} providers={PROVIDERS} onClose={onClose} onMoved={onMoved} />)
    return { onMoved, onClose }
}

const refusal = (status: number, detail: Record<string, unknown>) =>
    Object.assign(new Error(String(detail.message ?? 'refused')), { status, detail })

beforeEach(() => {
    moveProjection.mockReset()
})

describe('MoveProjectionDialog', () => {
    it('lists only the active FalkorDB providers', () => {
        renderDialog()
        const options = Array.from((screen.getByLabelText('Target provider') as HTMLSelectElement).options)
            .filter(o => o.value).map(o => o.textContent)
        expect(options).toEqual(['EU graph store', 'US graph store'])
    })

    it('says what a move costs before anything changes', () => {
        renderDialog()
        expect(screen.getByText(/Reads come from Postgres until the new copy catches up; aggregated lineage is missing until its rollups are rebuilt\. The current platform key is removed about 15 minutes after the new one catches up — until then you can move back\./))
            .toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
        expect(moveProjection).not.toHaveBeenCalled()
    })

    it('moves to the chosen provider on confirm, and hands the result back', async () => {
        moveProjection.mockResolvedValue(MOVED)
        const { onMoved } = renderDialog()

        await userEvent.selectOptions(screen.getByLabelText('Target provider'), 'falkor-us')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(moveProjection).toHaveBeenCalledWith('graph_b', { providerId: 'falkor-us' })
        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(MOVED))
    })

    it('sends a key given under Advanced', async () => {
        moveProjection.mockResolvedValue(MOVED)
        renderDialog()

        await userEvent.selectOptions(screen.getByLabelText('Target provider'), 'falkor-us')
        await userEvent.click(screen.getByText('Advanced'))
        await userEvent.type(screen.getByLabelText('Target key'), 'gvp_graph_b{{graph_b.2}')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(moveProjection).toHaveBeenCalledWith('graph_b', { providerId: 'falkor-us', key: 'gvp_graph_b{graph_b.2}' })
    })

    it('offers a move back onto a key the graph is still retiring, and prefills it', async () => {
        moveProjection.mockResolvedValue(MOVED)
        renderDialog({
            ...ROW, falkorProvider: 'falkor-us', falkorGraphName: 'gvp_graph_b{graph_b.1}',
            retiredKeys: [{ name: 'gvt_graph_b', provider: 'falkor-eu', retireAfter: '2026-10-18T12:15:00Z', afterSeq: 3 }],
        })

        await userEvent.click(screen.getByRole('button', { name: 'Move back to EU graph store · gvt_graph_b' }))
        expect(screen.getByLabelText('Target provider')).toHaveValue('falkor-eu')
        expect(screen.getByLabelText('Target key')).toHaveValue('gvt_graph_b')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(moveProjection).toHaveBeenCalledWith('graph_b', { providerId: 'falkor-eu', key: 'gvt_graph_b' })
    })

    it.each([
        ['the customer\'s own graph', refusal(409, { type: 'projection_not_adopted', reason: 'customer_key' }),
            'This is the customer\'s own graph. Only platform copies can be moved.'],
        ['a key other data sources read', refusal(409, { type: 'projection_not_adopted', reason: 'shared', sharedWith: 2 }),
            'Other data sources read this key.'],
        ['a key that already exists', refusal(409, { type: 'graph_key_in_use', providerId: 'falkor-us', key: 'gvp_x' }),
            'gvp_x already exists on US graph store.'],
        ['a running rollup rebuild', refusal(409, { type: 'job_active', jobId: 'job_1' }),
            'A rollup rebuild is running; try again when it finishes.'],
        ['a busy graph', refusal(503, { type: 'lock_busy', retryable: true }),
            'The graph is busy; try again in a few seconds.'],
    ])('explains a refusal for %s', async (_what, error, copy) => {
        moveProjection.mockRejectedValue(error)
        const { onMoved } = renderDialog()

        await userEvent.selectOptions(screen.getByLabelText('Target provider'), 'falkor-us')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(await screen.findByText(copy)).toBeInTheDocument()
        expect(onMoved).not.toHaveBeenCalled()
    })

    it('shows any other refusal as given', async () => {
        moveProjection.mockRejectedValue(new Error('provider not permitted in this workspace'))
        renderDialog()

        await userEvent.selectOptions(screen.getByLabelText('Target provider'), 'falkor-us')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(await screen.findByText('provider not permitted in this workspace')).toBeInTheDocument()
    })
})
