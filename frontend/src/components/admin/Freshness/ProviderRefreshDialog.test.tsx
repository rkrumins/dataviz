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
import { RefreshImpact, scopeRebuilds } from './RefreshImpact'

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

describe('refresh impact and confirmation', () => {
    it('knows which scopes rebuild', () => {
        expect(scopeRebuilds('rollups', false)).toBe(true)
        expect(scopeRebuilds('full', false)).toBe(true)
        expect(scopeRebuilds('auto', true)).toBe(true)
        expect(scopeRebuilds('auto', false)).toBe(false)
        expect(scopeRebuilds('read-caches', false)).toBe(false)
        expect(scopeRebuilds('clear', false)).toBe(false)
    })

    it('spells out cache clearing, queued jobs and duration for a full refresh', () => {
        render(<RefreshImpact scope="full" force={false} />)
        expect(screen.getByText(/clear cached canvas data/)).toBeInTheDocument()
        expect(screen.getByText(/queue a lineage rebuild job/)).toBeInTheDocument()
        expect(screen.getByText(/minutes to tens of minutes per source/)).toBeInTheDocument()
    })

    // There is no authoritative source count to show pre-batch (see
    // RefreshImpact's emptyLabel doc), so the provider-scoped fallback is
    // the only wording this dialog ever renders here.
    it('falls back to the provider-scoped wording, since there is no authoritative pre-batch count', () => {
        render(<RefreshImpact scope="full" force={false} />)
        expect(screen.getByText(/every live source using this provider/)).toBeInTheDocument()
    })

    it('never claims a rebuild for a cache-only scope', () => {
        render(<RefreshImpact scope="read-caches" force={false} />)
        expect(screen.queryByText(/rebuild/i)).not.toBeInTheDocument()
    })

    it('renders a meaningful line for the change-gated auto scope instead of an empty list', () => {
        render(<RefreshImpact scope="auto" force={false} />)
        expect(screen.getByText(/check each source and refresh only the ones whose data changed/)).toBeInTheDocument()
        expect(screen.queryByText(/rebuild/i)).not.toBeInTheDocument()
    })
})
