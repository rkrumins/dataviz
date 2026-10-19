/**
 * ReviewTransferDialog — the destination's admin answering a request.
 *
 * Pinned here: what changed since the request is said up front; the
 * proposer's choices read as they were made; Accept is pinned to the preview
 * on screen and stays shut while anything stands in the way; a 409 shows the
 * latest instead of moving anything; Decline carries the note the proposer
 * will read; and an answered request says how it ended, with nothing to do.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { svc } = vi.hoisted(() => ({ svc: { get: vi.fn(), accept: vi.fn(), decline: vi.fn() } }))
vi.mock('@/services/dataSourceTransferService', () => ({ dataSourceTransferService: svc }))
vi.mock('@/store/workspaces', () => ({ useWorkspacesStore: { getState: () => ({ loadWorkspaces: vi.fn() }) } }))

import { ReviewTransferDialog } from '../ReviewTransferDialog'
import { issue, preview, request, subject, transfer } from './fixtures'

function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <ReviewTransferDialog transferId="xfer_1" onClose={onClose} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { onClose }
}

const PLAN = preview({
    access: {
        creators: 1, sharedWith: 0, everyone: 0, gainsPeople: 12, gainsViews: 1, adminViews: 0,
        loses: [
            subject({ type: 'group', id: 'grp_analysts', name: 'Analysts', email: null, memberCount: 5, keep: true }),
            subject({ keep: false }),
        ],
    },
})

beforeEach(() => {
    vi.clearAllMocks()
    svc.get.mockResolvedValue({
        transfer: request({ canAccept: true, canDecline: true }),
        preview: PLAN,
        changesSinceRequest: { viewsAdded: 2, viewsRemoved: 0, newPeople: 1 },
    })
    svc.accept.mockResolvedValue(transfer({ kind: 'request' }))
    svc.decline.mockResolvedValue(request({ status: 'declined' }))
})

describe('ReviewTransferDialog', () => {
    it('says what changed, shows the proposer’s choices, and accepts against the preview on screen', async () => {
        const user = userEvent.setup()
        const { onClose } = renderDialog()

        expect(await screen.findByRole('heading', { name: 'Finance wants to move “Orders” to Risk' })).toBeInTheDocument()
        expect(screen.getByText(/2 new views will move too/)).toBeInTheDocument()
        expect(screen.getByText(/1 person or team not in the proposal will lose access/)).toBeInTheDocument()
        expect(screen.getByText('“Risk owns this now”')).toBeInTheDocument()
        const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement)
        expect(row('Analysts').getByText('Keeps access')).toBeInTheDocument()
        expect(row('Bob Ito').getByText('Loses access')).toBeInTheDocument()
        expect(screen.queryByRole('switch')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Accept and move' }))
        await waitFor(() => expect(svc.accept).toHaveBeenCalledWith('xfer_1', 'tok_1', undefined))
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('keeps Accept shut while something stands in the way', async () => {
        svc.get.mockResolvedValue({
            transfer: request({ canAccept: true, canDecline: true }),
            preview: preview({ blockers: [issue()] }),
            changesSinceRequest: null,
        })
        renderDialog()
        expect(await screen.findByText('An aggregation run is in progress.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Accept and move' })).toBeDisabled()
        expect(screen.getByText('Accept once nothing stands in the way.')).toBeInTheDocument()
    })

    it('shows the latest when the preview changed before Accept landed', async () => {
        const user = userEvent.setup()
        svc.accept.mockRejectedValue(Object.assign(new Error('A new view was built on it.'), { status: 409 }))
        const { onClose } = renderDialog()
        await user.click(await screen.findByRole('button', { name: 'Accept and move' }))

        expect(await screen.findByText(/Something changed — here’s the latest. Nothing has moved./)).toBeInTheDocument()
        expect(screen.getByText('A new view was built on it.')).toBeInTheDocument()
        await waitFor(() => expect(svc.get).toHaveBeenCalledTimes(2))
        expect(onClose).not.toHaveBeenCalled()
    })

    it('declines with a note the proposer reads', async () => {
        const user = userEvent.setup()
        const { onClose } = renderDialog()
        await user.click(await screen.findByRole('button', { name: 'Decline' }))
        await user.type(screen.getByRole('textbox', { name: 'Why you\'re declining' }), 'Not ours')
        await user.click(screen.getByRole('button', { name: 'Decline' }))

        await waitFor(() => expect(svc.decline).toHaveBeenCalledWith('xfer_1', 'Not ours'))
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('says how an answered request ended, with nothing left to do', async () => {
        svc.get.mockResolvedValue({
            transfer: request({
                status: 'declined',
                resolvedAt: new Date().toISOString(),
                resolvedBy: { id: 'usr_rita', name: 'Rita Risk' },
                resolutionNote: 'We have our own copy',
            }),
            preview: null,
            changesSinceRequest: null,
        })
        renderDialog()
        expect(await screen.findByText('Declined')).toBeInTheDocument()
        expect(screen.getByText('“We have our own copy”')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Accept and move' })).not.toBeInTheDocument()
    })
})
