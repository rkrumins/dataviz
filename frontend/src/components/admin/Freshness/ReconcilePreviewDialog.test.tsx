import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconcilePreviewDialog } from './ReconcilePreviewDialog'

const { reconcileNow, permissionFn } = vi.hoisted(() => ({
    reconcileNow: vi.fn(),
    permissionFn: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            reconcileNow,
        },
    }
})

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ showToast: vi.fn() }),
}))

describe('ReconcilePreviewDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        permissionFn.mockReturnValue(true)
        reconcileNow.mockResolvedValue({
            skipped: false,
            run: { scanned: 4, findings: 1, actions: 0, bySkip: { in_sync: 3 } },
            findings: [{
                dataSourceId: 'ds-1',
                name: 'Sol Xlarge',
                providerName: 'Warehouse',
                reason: 'overlay_missing',
                evidence: { expectedAggregatedEdges: 500, observedAggregatedEdges: 0 },
            }],
        })
    })

    it('names the source and its provider on a finding', async () => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={qc}>
                <ReconcilePreviewDialog open onClose={() => {}} fleetTotal={4} />
            </QueryClientProvider>,
        )
        expect(await screen.findByText('Sol Xlarge')).toBeInTheDocument()
        expect(screen.getByText(/Warehouse/)).toBeInTheDocument()
        expect(screen.getByText(/Rollups were missing/)).toBeInTheDocument()
        expect(screen.getByText(/4 of 4 checked/)).toBeInTheDocument()
        expect(screen.getByText(/3 in sync/)).toBeInTheDocument()
        expect(screen.getByText(/1 drifted/)).toBeInTheDocument()
        await waitFor(() => {
            expect(reconcileNow).toHaveBeenCalledWith({ dryRun: true })
        })
    })
})
