/**
 * TransferRequestsPanel — sources waiting to move, on the Requests tab and
 * as a workspace's banner.
 *
 * Pinned here: the tab lists what waits and opens a review; it says nothing
 * while nothing waits; the Inbox's `?transfer=` link opens that request even
 * when it is no longer open; and a workspace's banner shows both directions —
 * Review for what comes in, Cancel for what it asked another to take.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { svc } = vi.hoisted(() => ({
    svc: { listIncoming: vi.fn(), listForWorkspace: vi.fn(), get: vi.fn(), decline: vi.fn(), cancel: vi.fn() },
}))
vi.mock('@/services/dataSourceTransferService', () => ({ dataSourceTransferService: svc }))
vi.mock('@/store/workspaces', () => ({ useWorkspacesStore: { getState: () => ({ loadWorkspaces: vi.fn() }) } }))

import { TransferRequestsPanel } from '../TransferRequestsPanel'
import { RISK, preview, request } from './fixtures'

function renderPanel(ui: React.ReactElement, path = '/workspaces?tab=requests') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    svc.get.mockResolvedValue({ transfer: request({ canAccept: true }), preview: preview(), changesSinceRequest: null })
    svc.cancel.mockResolvedValue(request({ status: 'cancelled' }))
})

describe('TransferRequestsPanel — the Requests tab', () => {
    it('lists what is waiting and opens a review', async () => {
        const user = userEvent.setup()
        svc.listIncoming.mockResolvedValue([request({ canDecline: true })])
        renderPanel(<TransferRequestsPanel />)

        expect(await screen.findByText('Data sources waiting to move in')).toBeInTheDocument()
        expect(screen.getByText('Orders')).toBeInTheDocument()
        expect(screen.getByText(/2 views · asked by Ana Admin/)).toBeInTheDocument()
        expect(screen.getByText('“Risk owns this now”')).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Review/ }))
        await waitFor(() => expect(svc.get).toHaveBeenCalledWith('xfer_1'))
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
    })

    it('says nothing while nothing is waiting', async () => {
        svc.listIncoming.mockResolvedValue([])
        const { container } = renderPanel(<TransferRequestsPanel />)
        await waitFor(() => expect(svc.listIncoming).toHaveBeenCalledWith('open'))
        expect(container).toBeEmptyDOMElement()
    })

    it('opens the request the Inbox linked to, answered or not', async () => {
        svc.listIncoming.mockResolvedValue([])
        renderPanel(<TransferRequestsPanel />, '/workspaces?tab=requests&transfer=xfer_9')
        await waitFor(() => expect(svc.get).toHaveBeenCalledWith('xfer_9'))
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
    })
})

describe('TransferRequestsPanel — a workspace’s banner', () => {
    it('shows what waits for this workspace and what it asked another to take', async () => {
        const user = userEvent.setup()
        svc.listForWorkspace.mockResolvedValue([
            request(),
            request({
                id: 'xfer_2',
                dataSource: { id: 'ds_claims', name: 'Claims', type: 'data_source' },
                fromWorkspace: RISK,
                toWorkspace: { id: 'ws_ops', name: 'Operations' },
                canCancel: true,
            }),
        ])
        renderPanel(<TransferRequestsPanel variant="banner" workspaceId={RISK.id} />, '/workspaces/ws_risk')

        expect(await screen.findByText(/is\s+waiting for you to accept it/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Review/ })).toBeInTheDocument()
        expect(screen.getByText(/is waiting for Operations’s admins/)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Cancel request' }))
        await waitFor(() => expect(svc.cancel).toHaveBeenCalledWith('xfer_2', undefined))
    })
})
