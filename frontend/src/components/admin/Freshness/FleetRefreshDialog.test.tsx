/**
 * FleetRefreshDialog — Task 9 review Finding 1: RefreshImpact's default
 * fallback copy ("this provider") has no antecedent in this dialog, which
 * spans every provider in the fleet. This covers only that scoping; the
 * shared scope/impact logic itself is covered by RefreshImpact's own tests
 * in ProviderRefreshDialog.test.tsx.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const { useRefreshFleet, useRefreshBatch } = vi.hoisted(() => ({
    useRefreshFleet: vi.fn(),
    useRefreshBatch: vi.fn(),
}))

vi.mock('./useFreshness', async () => {
    const actual = await vi.importActual<typeof import('./useFreshness')>('./useFreshness')
    return { ...actual, useRefreshFleet, useRefreshBatch }
})

import { FleetRefreshDialog } from './FleetRefreshDialog'

function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <FleetRefreshDialog fleetTotal={31} isOpen onClose={vi.fn()} />
        </QueryClientProvider>,
    )
}

describe('FleetRefreshDialog', () => {
    it('scopes the impact wording to the fleet instead of "this provider"', () => {
        useRefreshFleet.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null })
        useRefreshBatch.mockReturnValue({ data: undefined })

        renderDialog()

        expect(screen.getByText(/every live source in the fleet/)).toBeInTheDocument()
        expect(screen.queryByText(/this provider/)).not.toBeInTheDocument()
    })
})
