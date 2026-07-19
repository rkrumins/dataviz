/**
 * ProviderRefreshDialog — a batch that strands at "running" (dead CP runner,
 * erroring status GET) must stay dismissable: the Close button is enabled
 * while running and closing fires onClose (it doesn't cancel the batch).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const { useRefreshProvider, useRefreshBatch } = vi.hoisted(() => ({
    useRefreshProvider: vi.fn(),
    useRefreshBatch: vi.fn(),
}))

vi.mock('./useFreshness', async () => {
    const actual = await vi.importActual<typeof import('./useFreshness')>('./useFreshness')
    return { ...actual, useRefreshProvider, useRefreshBatch }
})

import { ProviderRefreshDialog } from './ProviderRefreshDialog'

function renderDialog(onClose = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <ProviderRefreshDialog providerId="p1" providerName="Warehouse" isOpen onClose={onClose} />
        </QueryClientProvider>,
    )
    return onClose
}

describe('ProviderRefreshDialog', () => {
    it('stays dismissable while the batch is still running', async () => {
        const user = userEvent.setup()
        // mutate() succeeds synchronously with a batch id; the batch never
        // leaves "running" (as if the runner died).
        useRefreshProvider.mockReturnValue({
            mutate: (_vars: unknown, opts: { onSuccess: (r: { batchId: string }) => void }) =>
                opts.onSuccess({ batchId: 'b1' }),
            isPending: false, isError: false, error: null,
        })
        useRefreshBatch.mockReturnValue({
            data: { batchId: 'b1', providerId: 'p1', total: 3, done: 1, results: [], state: 'running' },
        })

        const onClose = renderDialog()

        await user.click(screen.getByRole('button', { name: /start refresh/i }))

        // Progress view: authoritative total shown, background copy present.
        expect(await screen.findByText(/continues in the background/i)).toBeInTheDocument()
        expect(screen.getByText('1 / 3')).toBeInTheDocument()

        const close = screen.getByRole('button', { name: /^close$/i })
        expect(close).toBeEnabled()
        await user.click(close)
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })
})
