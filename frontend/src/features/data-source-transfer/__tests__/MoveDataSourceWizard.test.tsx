/**
 * MoveDataSourceWizard — the guided move of a data source and its views.
 *
 * Pinned here: the steps run Destination → What moves → Access → Confirm; a
 * blocker keeps Next shut; exactly the people whose switch is on keep access,
 * and the preview's token and the reason go with the move; a 409 (the preview
 * changed) goes back to show the latest instead of failing; someone who runs
 * only this workspace sends a request instead; a preset destination skips its
 * step and a source with no views skips Access; and the terminal offers Undo
 * and the way into the destination.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { svc, navigate } = vi.hoisted(() => ({
    svc: {
        destinations: vi.fn(), preview: vi.fn(), move: vi.fn(), propose: vi.fn(),
        history: vi.fn(), cancel: vi.fn(), undo: vi.fn(),
    },
    navigate: vi.fn(),
}))
vi.mock('@/services/dataSourceTransferService', () => ({ dataSourceTransferService: svc }))
vi.mock('@/store/workspaces', () => ({ useWorkspacesStore: { getState: () => ({ loadWorkspaces: vi.fn() }) } }))
vi.mock('react-router-dom', async (orig) => ({
    ...(await orig<typeof import('react-router-dom')>()),
    useNavigate: () => navigate,
}))

import { MoveDataSourceWizard, type MoveDataSourceWizardProps } from '../MoveDataSourceWizard'
import { FINANCE, destination, issue, preview, transfer, request } from './fixtures'

function renderWizard(props: Partial<MoveDataSourceWizardProps> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <MoveDataSourceWizard
                    isOpen
                    sourceWorkspace={FINANCE}
                    dataSource={{ id: 'ds_orders', label: 'Orders' }}
                    onClose={onClose}
                    onDone={onDone}
                    {...props}
                />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return { onDone, onClose }
}

const next = () => screen.getByRole('button', { name: /^Next/ })

async function toConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('radio', { name: /^Risk/ }))
    await user.click(next())
    expect(await screen.findByText('Revenue lineage')).toBeInTheDocument()
    await user.click(next())
    expect(await screen.findByText('Analysts')).toBeInTheDocument()
}

beforeEach(() => {
    vi.clearAllMocks()
    svc.destinations.mockResolvedValue([
        destination(),
        destination({ id: 'ws_ops', name: 'Operations', mode: 'request' }),
        destination({ id: 'ws_arc', name: 'Archive', mode: null, reason: 'Already has this graph' }),
    ])
    svc.preview.mockResolvedValue(preview())
    svc.history.mockResolvedValue([])
    svc.move.mockResolvedValue(transfer())
    svc.propose.mockResolvedValue(request())
    svc.undo.mockResolvedValue(transfer({ status: 'undone', undoneAt: new Date().toISOString(), canUndo: false }))
})

describe('MoveDataSourceWizard', () => {
    it('moves it with exactly the access the person chose, the preview’s token and their reason', async () => {
        const user = userEvent.setup()
        const { onDone } = renderWizard()

        // Unavailable workspaces are listed apart, saying why.
        expect(await screen.findByText(/1 workspace can’t take it/)).toBeInTheDocument()
        await toConfirm(user)
        expect(screen.getByText('2 of 2')).toBeInTheDocument()

        await user.click(screen.getByRole('switch', { name: 'Keep Bob Ito’s access' }))
        expect(screen.getByText('1 of 2')).toBeInTheDocument()
        await user.click(next())

        expect(await screen.findByText(/1 of 2 people and teams keep view-only access; 1 lose it/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Team reorganisation' }))
        await user.click(screen.getByRole('button', { name: 'Move to Risk' }))

        await waitFor(() => expect(svc.move).toHaveBeenCalledWith('ws_fin', 'ds_orders', {
            targetWorkspaceId: 'ws_risk',
            keep: [{ type: 'group', id: 'grp_analysts' }],
            previewToken: 'tok_1',
        }, 'Team reorganisation'))
        expect(await screen.findByRole('heading', { name: '“Orders” now lives in Risk' })).toBeInTheDocument()
        expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'xfer_1' }))
    })

    it('keeps Next shut while something stands in the way', async () => {
        const user = userEvent.setup()
        svc.preview.mockResolvedValue(preview({ blockers: [issue()] }))
        renderWizard()
        await user.click(await screen.findByRole('radio', { name: /^Risk/ }))
        await user.click(next())
        expect(await screen.findByText('An aggregation run is in progress.')).toBeInTheDocument()
        expect(screen.getByText('Resolve before moving')).toBeInTheDocument()
        expect(next()).toBeDisabled()
    })

    it('goes back to show the latest when the preview changed meanwhile', async () => {
        const user = userEvent.setup()
        svc.move.mockRejectedValue(Object.assign(new Error('Two new views were built on it since.'), { status: 409 }))
        renderWizard()
        await toConfirm(user)
        await user.click(next())
        await user.click(await screen.findByRole('button', { name: 'Move to Risk' }))

        expect(await screen.findByText(/Something changed — here’s the latest/)).toBeInTheDocument()
        expect(screen.getByText('Two new views were built on it since.')).toBeInTheDocument()
        await waitFor(() => expect(svc.preview).toHaveBeenCalledTimes(2))
    })

    it('sends a request when the person runs only this workspace', async () => {
        const user = userEvent.setup()
        svc.preview.mockResolvedValue(preview({ mode: 'request', toWorkspace: { id: 'ws_ops', name: 'Operations' } }))
        renderWizard()
        await user.click(await screen.findByRole('radio', { name: /^Operations/ }))
        await user.click(next())
        await user.click(await screen.findByRole('button', { name: /^Next/ }))
        expect(await screen.findByText(/Operations’s admins will see who you chose/)).toBeInTheDocument()
        await user.click(next())

        await user.click(await screen.findByRole('button', { name: 'Send request' }))
        await waitFor(() => expect(svc.propose).toHaveBeenCalledWith('ws_fin', 'ds_orders', expect.objectContaining({
            targetWorkspaceId: 'ws_ops', previewToken: 'tok_1',
        }), undefined))
        expect(svc.move).not.toHaveBeenCalled()
        expect(await screen.findByRole('heading', { name: 'Request sent to Operations' })).toBeInTheDocument()
    })

    it('skips Destination when it is preset, and Access when no views move', async () => {
        const user = userEvent.setup()
        svc.preview.mockResolvedValue(preview({
            views: [],
            viewCounts: { total: 0, trashed: 0, followsDefault: 0, private: 0, workspace: 0, enterprise: 0, publishRequested: 0 },
            access: { creators: 0, sharedWith: 0, everyone: 0, gainsPeople: 0, gainsViews: 0, adminViews: 0, loses: [] },
        }))
        renderWizard({ presetDestinationId: 'ws_risk' })

        expect(await screen.findByText('Nothing is built on it yet')).toBeInTheDocument()
        expect(screen.queryByTitle('Destination')).not.toBeInTheDocument()
        expect(screen.queryByTitle('Access')).not.toBeInTheDocument()
        expect(svc.destinations).not.toHaveBeenCalled()

        await user.click(next())
        expect(await screen.findByRole('button', { name: 'Move to Risk' })).toBeInTheDocument()
        // The step body swaps after the previous one exits; the footer is already there.
        expect(await screen.findByText('No views are built on it.')).toBeInTheDocument()
    })

    it('offers Undo and the way into the destination once it has moved', async () => {
        const user = userEvent.setup()
        renderWizard()
        await toConfirm(user)
        await user.click(next())
        await user.click(await screen.findByRole('button', { name: 'Move to Risk' }))
        await screen.findByRole('heading', { name: '“Orders” now lives in Risk' })

        await user.click(screen.getByRole('button', { name: /Open in Risk/ }))
        expect(navigate).toHaveBeenCalledWith('/workspaces/ws_risk?ds=ds_orders')

        await user.click(screen.getByRole('button', { name: 'Undo' }))
        await user.click(await screen.findByRole('button', { name: 'Move it back' }))
        await waitFor(() => expect(svc.undo).toHaveBeenCalledWith('xfer_1', undefined))
        expect(await screen.findByRole('heading', { name: '“Orders” is back in Finance' })).toBeInTheDocument()
    })
})
