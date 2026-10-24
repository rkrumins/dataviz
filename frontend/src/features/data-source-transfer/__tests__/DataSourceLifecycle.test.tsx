/**
 * DataSourceLifecycle and MovedFromChip — where a data source has lived.
 *
 * Pinned here: a move into this workspace offers Undo through a confirmation,
 * or says why it no longer can; a request still waiting can be cancelled by
 * whoever may; the history tells every move as the moments people would name;
 * a source that never moved shows nothing; and the header chip names where
 * it came from.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { svc } = vi.hoisted(() => ({ svc: { history: vi.fn(), undo: vi.fn(), cancel: vi.fn() } }))
vi.mock('@/services/dataSourceTransferService', () => ({ dataSourceTransferService: svc }))
vi.mock('@/store/workspaces', () => ({ useWorkspacesStore: { getState: () => ({ loadWorkspaces: vi.fn() }) } }))

import { DataSourceLifecycle, MovedFromChip } from '../DataSourceLifecycle'
import { FINANCE, RISK, request, transfer } from './fixtures'

function renderUi(ui: React.ReactElement) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>{ui}</MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    svc.undo.mockResolvedValue(transfer({ status: 'undone', undoneAt: new Date().toISOString() }))
    svc.cancel.mockResolvedValue(request({ status: 'cancelled' }))
})

describe('DataSourceLifecycle', () => {
    it('offers Undo on a move into this workspace, through a confirmation', async () => {
        const user = userEvent.setup()
        svc.history.mockResolvedValue([transfer({ reason: 'Team reorganisation' })])
        const onChanged = vi.fn()
        renderUi(<DataSourceLifecycle wsId={RISK.id} dataSourceId="ds_orders" onChanged={onChanged} />)

        expect(await screen.findByText(/by Ana Admin/)).toBeInTheDocument()
        expect(screen.getByText(/“Team reorganisation”/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Undo/ }))
        expect(await screen.findByRole('heading', { name: 'Move it back to Finance?' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Move it back' }))

        await waitFor(() => expect(svc.undo).toHaveBeenCalledWith('xfer_1', undefined))
        await waitFor(() => expect(onChanged).toHaveBeenCalled())
    })

    it('says why a move can no longer be undone', async () => {
        svc.history.mockResolvedValue([transfer({ canUndo: false, undoBlockedBy: '2 views were built on it here since.' })])
        renderUi(<DataSourceLifecycle wsId={RISK.id} dataSourceId="ds_orders" />)
        expect(await screen.findByText('2 views were built on it here since.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument()
    })

    it('lets a request still waiting be cancelled', async () => {
        const user = userEvent.setup()
        svc.history.mockResolvedValue([request({ canCancel: true })])
        renderUi(<DataSourceLifecycle wsId={FINANCE.id} dataSourceId="ds_orders" />)

        expect(await screen.findByText(/’s admins/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Cancel request' }))
        await waitFor(() => expect(svc.cancel).toHaveBeenCalledWith('xfer_1', undefined))
    })

    it('tells the history as the moments people would name', async () => {
        const user = userEvent.setup()
        const now = Date.now()
        svc.history.mockResolvedValue([
            transfer({
                status: 'undone', canUndo: false,
                completedAt: new Date(now - 2 * 3_600_000).toISOString(),
                undoneAt: new Date(now - 3_600_000).toISOString(),
                undoneBy: { id: 'usr_ana', name: 'Ana Admin' },
            }),
            request({
                id: 'xfer_0', status: 'declined',
                createdAt: new Date(now - 5 * 86_400_000).toISOString(),
                resolvedAt: new Date(now - 4 * 86_400_000).toISOString(),
                resolvedBy: { id: 'usr_rita', name: 'Rita Risk' },
                resolutionNote: 'Not ours yet',
            }),
        ])
        renderUi(<DataSourceLifecycle wsId={FINANCE.id} dataSourceId="ds_orders" />)

        await user.click(await screen.findByRole('button', { name: /Where it has lived \(4\)/ }))
        const titles = screen.getAllByText(/Move undone|Moved from|declined|Asked Risk/).map(el => el.textContent)
        expect(titles).toEqual([
            'Move undone — back in Finance',
            'Moved from Finance to Risk',
            'Risk declined',
            'Asked Risk to take it',
        ])
        expect(screen.getByText('“Not ours yet”')).toBeInTheDocument()
    })

    it('shows nothing for a source that never moved', async () => {
        svc.history.mockResolvedValue([])
        const { container } = renderUi(<DataSourceLifecycle wsId={FINANCE.id} dataSourceId="ds_orders" />)
        await waitFor(() => expect(svc.history).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
    })
})

describe('MovedFromChip', () => {
    it('names where the source came from', async () => {
        svc.history.mockResolvedValue([transfer()])
        renderUi(<MovedFromChip wsId={RISK.id} dataSourceId="ds_orders" />)
        expect(await screen.findByText('Moved from Finance')).toBeInTheDocument()
    })
})
