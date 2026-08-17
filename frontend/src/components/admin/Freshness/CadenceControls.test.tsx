/**
 * F9 cadence controls — the per-source override row in the drawer. It shows
 * the RESOLVED value + where that value came from, and its editor fires the
 * freshness-settings PATCH.
 *
 * The global editor moved out of a modal and into the page; its tests live in
 * AutomationPanel.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    getSourceDoc, patchFreshnessSettings, getAggregationSettings,
    putAggregationCadence, listJobsGlobal, permissionFn,
    getReconciliation, putReconciliation, reconcileNow,
} = vi.hoisted(() => ({
    getSourceDoc: vi.fn(),
    patchFreshnessSettings: vi.fn(),
    getAggregationSettings: vi.fn(),
    putAggregationCadence: vi.fn(),
    listJobsGlobal: vi.fn(),
    permissionFn: vi.fn(),
    getReconciliation: vi.fn(),
    putReconciliation: vi.fn(),
    reconcileNow: vi.fn(),
}))

/** The drawer resolves each source's automation state against the global
 *  policy, so every cadence test needs it resolvable. */
const RECON_POLICY = {
    enabled: true, checkIntervalSecs: null, maxActionsPerRun: null,
    shrinkTolerancePct: null, detectors: null,
    envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
    envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700,
    allDetectors: ['overlay_missing', 'overlay_shrunk', 'never_aggregated', 'raw_drift'],
}

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            getSourceDoc, patchFreshnessSettings,
            getReconciliation, putReconciliation, reconcileNow,
        },
    }
})

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getAggregationSettings, putAggregationCadence, listJobsGlobal },
    }
})

import { FreshnessDrawer } from './FreshnessDrawer'

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>,
    )
}

function makeDoc(over: Record<string, unknown> = {}) {
    return {
        dataSourceId: 'ds-1', workspaceId: 'ws-1', name: 'Orders', providerName: 'Warehouse',
        aggregationStatus: 'ready', events: [],
        rebuildOverrideSecs: null, resolvedRebuildIntervalSecs: 900, rebuildIntervalSource: 'default',
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
    // FreshnessDrawer joins a live job via useActiveJobs(); without this the
    // real listJobsGlobal would fire an actual network call from this unit test.
    listJobsGlobal.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
    getReconciliation.mockResolvedValue({ policy: RECON_POLICY, runs: [] })
    putReconciliation.mockResolvedValue(RECON_POLICY)
})

describe('drawer rebuild-cadence row', () => {
    it('shows the resolved value and its source', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            rebuildOverrideSecs: 3600, resolvedRebuildIntervalSecs: 3600, rebuildIntervalSource: 'custom',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.getByText('Custom')).toBeInTheDocument()
        // 3600s → "1h" in the resolved-value copy.
        expect(screen.getByText('1h')).toBeInTheDocument()
    })

    it('edit fires the PATCH with the interval in seconds', async () => {
        getSourceDoc.mockResolvedValue(makeDoc())
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1', rebuildMinIntervalSecs: 300 })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        const input = await screen.findByLabelText('Rebuild cadence override (minutes)')
        await userEvent.clear(input)
        await userEvent.type(input, '5')
        await userEvent.click(screen.getByRole('button', { name: 'Save rebuild cadence' }))

        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalledWith(
            'ds-1', { rebuildMinIntervalSecs: 300 },
        ))
    })

    it('hides the editor without ds:manage', async () => {
        permissionFn.mockReturnValue(false)
        getSourceDoc.mockResolvedValue(makeDoc())
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.queryByLabelText('Rebuild cadence override (minutes)')).not.toBeInTheDocument()
    })

    it('hides the editor for a never-built source (no state row → would 404)', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            lastAggregatedAt: null, aggregationStatus: 'none',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.queryByLabelText('Rebuild cadence override (minutes)')).not.toBeInTheDocument()
        expect(screen.getByText(/once this source has been built/i)).toBeInTheDocument()
    })
})
