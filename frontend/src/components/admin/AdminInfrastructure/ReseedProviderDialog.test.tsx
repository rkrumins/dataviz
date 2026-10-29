/**
 * Reseeding a FalkorDB provider from Postgres, after its instance was
 * restored or rebuilt: the confirm says how many versioned graphs it will
 * reseed before anything changes, and only the confirm resets them.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resetWatermarks, notify } = vi.hoisted(() => ({ resetWatermarks: vi.fn(), notify: vi.fn() }))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, resetWatermarks } }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { ReseedProviderDialog } from './ReseedProviderDialog'
import type { GraphProvider } from '@/services/systemStatusService'

const PROVIDER: GraphProvider = {
    id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true,
}

function renderDialog(onClose = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <ReseedProviderDialog provider={PROVIDER} onClose={onClose} />
        </QueryClientProvider>,
    )
    return onClose
}

beforeEach(() => {
    resetWatermarks.mockReset()
    notify.mockReset()
    resetWatermarks.mockImplementation(async (provider: string, opts?: { dryRun?: boolean }) =>
        opts?.dryRun ? { provider, graphsToReset: 3 } : { provider, graphsReset: 3 })
})

describe('ReseedProviderDialog', () => {
    it('counts the graphs first and changes nothing until confirmed', async () => {
        const onClose = renderDialog()
        expect(await screen.findByText(/3 versioned graphs on EU graph store will be reseeded/)).toBeInTheDocument()
        expect(resetWatermarks).toHaveBeenCalledTimes(1)
        expect(resetWatermarks).toHaveBeenCalledWith('falkor-eu', { dryRun: true })

        await userEvent.click(screen.getByRole('button', { name: /Reseed 3 graphs/ }))
        await waitFor(() => expect(onClose).toHaveBeenCalled())
        expect(resetWatermarks).toHaveBeenLastCalledWith('falkor-eu')
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('3 versioned graphs'))
    })

    it('cancelling resets nothing', async () => {
        const onClose = renderDialog()
        await screen.findByText(/3 versioned graphs/)
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onClose).toHaveBeenCalled()
        expect(resetWatermarks).toHaveBeenCalledTimes(1)
    })
})
