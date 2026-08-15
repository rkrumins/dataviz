import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BulkRetryBar } from './BulkRetryBar'
import type { FreshnessRow } from '@/services/freshnessService'

const { refreshSource, showToast } = vi.hoisted(() => ({
    refreshSource: vi.fn(),
    showToast: vi.fn(),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            refreshSource,
        },
    }
})

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ showToast }),
}))

const ready: FreshnessRow = {
    dataSourceId: 'ds-ready',
    workspaceId: 'ws-1',
    providerId: 'prov-1',
    name: 'Healthy Source',
    providerName: 'Warehouse',
    aggregationStatus: 'ready',
    staleReason: null,
    cacheAsOf: new Date().toISOString(),
    lastAggregatedAt: new Date().toISOString(),
    runningJobId: null,
    lastEvent: null,
}

const failed: FreshnessRow = {
    ...ready,
    dataSourceId: 'ds-fail',
    name: 'Broken Source',
    aggregationStatus: 'failed',
    lastFailureCategory: 'out_of_memory',
    lastFailureReason: 'OOM',
}

describe('BulkRetryBar', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        refreshSource.mockResolvedValue({ scope: 'read-caches', gate: 'n/a', changed: true, actions: [], deferred: false })
    })

    it('offers Refresh caches and Rebuild lineage for a ready selection', async () => {
        const user = userEvent.setup()
        const onClear = vi.fn()
        const onDone = vi.fn()
        render(
            <QueryClientProvider client={new QueryClient()}>
                <BulkRetryBar
                    selectedIds={['ds-ready']}
                    rows={[ready]}
                    onClear={onClear}
                    onDone={onDone}
                />
            </QueryClientProvider>,
        )
        expect(screen.getByRole('button', { name: /refresh caches/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /rebuild lineage/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /retry rebuild/i })).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /refresh caches/i }))
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-ready', expect.objectContaining({ scope: 'read-caches' }))
        })
        expect(onDone).toHaveBeenCalled()
        expect(onClear).toHaveBeenCalled()
    })

    it('offers Retry rebuild only for failed ids in a mixed selection', async () => {
        const user = userEvent.setup()
        render(
            <QueryClientProvider client={new QueryClient()}>
                <BulkRetryBar
                    selectedIds={['ds-ready', 'ds-fail']}
                    rows={[ready, failed]}
                    onClear={() => {}}
                    onDone={() => {}}
                />
            </QueryClientProvider>,
        )
        expect(screen.getByRole('button', { name: /retry rebuild/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /rebuild lineage/i })).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /retry rebuild/i }))
        await user.click(screen.getByRole('button', { name: /confirm retry/i }))
        await waitFor(() => {
            expect(refreshSource).toHaveBeenCalledWith('ds-fail', expect.objectContaining({ scope: 'rollups' }))
        })
        expect(refreshSource).not.toHaveBeenCalledWith('ds-ready', expect.objectContaining({ scope: 'rollups' }))
    })
})
