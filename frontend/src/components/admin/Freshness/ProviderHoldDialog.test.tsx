/**
 * ProviderHoldDialog — the drawer's snooze at provider scope: a pause writes
 * through the provider-hold PUT and closes; a fleet hold turns the row into
 * a read-out (most restrictive wins, so no provider control could release
 * it); a provider's own stop offers Resume.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderFreshnessSummary } from '@/services/freshnessService'

const { useSetProviderHold } = vi.hoisted(() => ({ useSetProviderHold: vi.fn() }))

vi.mock('./useFreshness', async () => {
    const actual = await vi.importActual<typeof import('./useFreshness')>('./useFreshness')
    return { ...actual, useSetProviderHold }
})

import { ProviderHoldDialog } from './ProviderHoldDialog'

const BASE: ProviderFreshnessSummary = {
    providerId: 'p1', providerName: 'Warehouse', total: 3, ready: 3, pending: 0, failed: 0,
    notBuilt: 0, needsAttention: 0, cacheStamped: 3, drifting: 0, suspended: 0,
}

function renderDialog(current: ProviderFreshnessSummary | null, onClose = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <ProviderHoldDialog providerId="p1" providerName="Warehouse" current={current} isOpen onClose={onClose} />
        </QueryClientProvider>,
    )
    return onClose
}

function mutateThatSucceeds() {
    const mutate = vi.fn((_vars: unknown, opts: { onSuccess: (r: unknown) => void }) => opts.onSuccess({}))
    useSetProviderHold.mockReturnValue({ mutate, isPending: false })
    return mutate
}

describe('ProviderHoldDialog', () => {
    it('a timed pause writes through the provider hold and closes', async () => {
        const mutate = mutateThatSucceeds()
        const onClose = renderDialog(BASE)

        await userEvent.selectOptions(screen.getByLabelText("Pause this provider's rebuilds for"), '28800')

        await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
        expect(mutate.mock.calls[0][0]).toEqual({ providerId: 'p1', pausedUntil: expect.any(String) })
        expect(onClose).toHaveBeenCalled()
    })

    it('"until resumed" stops the provider', async () => {
        const mutate = mutateThatSucceeds()
        renderDialog(BASE)

        await userEvent.selectOptions(screen.getByLabelText("Pause this provider's rebuilds for"), 'stop')

        await waitFor(() => expect(mutate.mock.calls[0][0]).toEqual({ providerId: 'p1', pausedUntil: null, stopped: true }))
    })

    it('a stopped provider offers Resume, which lifts both stamps', async () => {
        const mutate = mutateThatSucceeds()
        renderDialog({ ...BASE, heldBy: 'provider', heldKind: 'stopped' })

        expect(screen.getByText("This provider's rebuilds are stopped")).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /resume now/i }))

        await waitFor(() => expect(mutate.mock.calls[0][0]).toEqual({ providerId: 'p1', pausedUntil: null, stopped: false }))
    })

    it('under a fleet hold the row is a read-out naming where to resume', () => {
        mutateThatSucceeds()
        renderDialog({ ...BASE, heldBy: 'fleet', heldKind: 'stopped' })

        expect(screen.getByText('Rebuilds are held fleet-wide')).toBeInTheDocument()
        expect(screen.getByText(/resume it from Automation/)).toBeInTheDocument()
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /resume now/i })).not.toBeInTheDocument()
    })
})
