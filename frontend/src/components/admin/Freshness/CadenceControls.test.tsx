/**
 * The drawer's per-source automation controls — ① Detect, ② Check, ③ Act, the
 * same three stages the fleet-wide Automation modal speaks. Each shows the
 * RESOLVED value + where that value came from, and its editor fires the
 * freshness-settings PATCH.
 *
 * The global editor is the Automation modal now; its tests live in
 * AutomationModal.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    getSourceDoc, patchFreshnessSettings, getAggregationSettings,
    listJobsGlobal, permissionFn,
    getReconciliation, putReconciliation, reconcileNow,
} = vi.hoisted(() => ({
    getSourceDoc: vi.fn(),
    patchFreshnessSettings: vi.fn(),
    getAggregationSettings: vi.fn(),
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
        aggregationService: { ...actual.aggregationService, getAggregationSettings, listJobsGlobal },
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

/** The rebuild cadence is ③ Act's, and its editor is a ``DurationField`` —
 *  reached as a labelled group rather than a bare minutes box, so asserting
 *  its absence still asserts something. ``ACT_CADENCE`` is the one string that
 *  names it, as the visible label and as the control's accessible name. */
const ACT_CADENCE = 'Minimum time between rebuilds'

describe('drawer rebuild-cadence row', () => {
    it('shows the resolved value and its source', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            rebuildOverrideSecs: 3600, resolvedRebuildIntervalSecs: 3600, rebuildIntervalSource: 'custom',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(ACT_CADENCE)).toBeInTheDocument()
        expect(screen.getByText('Custom')).toBeInTheDocument()
        // 3600s → "1h", flagged as an override because no preset offers it.
        expect(screen.getByText(/Overridden: 1h/)).toBeInTheDocument()
    })

    it('edit fires the PATCH with the interval in seconds', async () => {
        getSourceDoc.mockResolvedValue(makeDoc())
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1', rebuildMinIntervalSecs: 300 })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        // The cadence is entered in seconds now — the whole point of the shared
        // DurationField is that no stage asks the operator to convert units.
        const input = await screen.findByLabelText(`${ACT_CADENCE} (custom, seconds)`)
        await userEvent.clear(input)
        await userEvent.type(input, '300')
        await userEvent.click(screen.getByRole('button', { name: 'Save rebuild cadence' }))

        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalledWith(
            'ds-1', { rebuildMinIntervalSecs: 300 },
        ))
    })

    it('hides the editor without ds:manage', async () => {
        permissionFn.mockReturnValue(false)
        getSourceDoc.mockResolvedValue(makeDoc())
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(ACT_CADENCE)).toBeInTheDocument()
        expect(screen.queryByRole('group', { name: ACT_CADENCE })).not.toBeInTheDocument()
        // The value itself still reads — a viewer who cannot change the cadence
        // still needs to know what it is.
        expect(screen.getByText('15m')).toBeInTheDocument()
    })

    it('hides the editor for a never-built source (no state row → would 404)', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            lastAggregatedAt: null, aggregationStatus: 'none',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(/once this source has been built/i)).toBeInTheDocument()
        expect(screen.queryByRole('group', { name: ACT_CADENCE })).not.toBeInTheDocument()
    })
})

describe('drawer detect stage', () => {
    it('offers a detect override', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({ resolvedProbeIntervalSecs: 60 }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(/Using default \(1m\)/)).toBeInTheDocument()
    })

    it('sends the detect override in seconds', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({ resolvedProbeIntervalSecs: 60 }))
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1', probeIntervalSecs: 30 })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        // The 30s preset: this per-source override had no UI anywhere before,
        // so the only way to quieten one noisy source was fleet-wide.
        await userEvent.click(await screen.findByRole('button', { name: '30s' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save detect frequency' }))

        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalledWith(
            'ds-1', { probeIntervalSecs: 30 },
        ))
    })
})

describe('drawer drift explanation', () => {
    it('explains why a source is drifting from the stored evidence', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            driftState: 'overlayMissing',
            lastFindingReason: 'overlay_missing',
            lastFindingEvidence: {
                expectedAggregatedEdges: 50000, observedAggregatedEdges: 0,
            },
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(/Rollups went missing/)).toBeInTheDocument()
        // Exact, not /50,000/: the pair renders the count AND its delta, so a
        // loose match finds "50,000" and "(-50,000)" and fails as ambiguous.
        expect(screen.getByText('50,000')).toBeInTheDocument()
        expect(screen.getByText('(-50,000)')).toBeInTheDocument()
    })

    it('stays quiet when the source is in sync', async () => {
        // The sweep stamps a finding on every evaluation, so a stale reason
        // outlives the condition — the verdict decides whether it is shown.
        getSourceDoc.mockResolvedValue(makeDoc({
            driftState: 'inSync',
            lastFindingReason: 'overlay_missing',
            lastFindingEvidence: { expectedAggregatedEdges: 50000, observedAggregatedEdges: 0 },
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText(ACT_CADENCE)).toBeInTheDocument()
        expect(screen.queryByText(/Rollups went missing/)).not.toBeInTheDocument()
    })
})

/** The snooze lives in ③ Act, because ③ Act is the only stage it holds:
 *  ``reconcile._hold`` gates the dispatch, never the probe or the check. The
 *  words have to say that — "pause automation" would claim the two stages
 *  above it stop too. */
describe('drawer snooze', () => {
    it('pauses rebuilds for the chosen window', async () => {
        getSourceDoc.mockResolvedValue(makeDoc())
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1' })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        const before = Date.now()
        await userEvent.selectOptions(
            await screen.findByLabelText('Pause rebuilds for'), '28800',
        )

        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalled())
        const [dsId, body] = patchFreshnessSettings.mock.calls[0]
        expect(dsId).toBe('ds-1')
        // An instant, not a duration: the server holds until a wall-clock time,
        // so the window is computed here and sent as ISO.
        const until = new Date(body.pausedUntil).getTime()
        expect(until - before).toBeGreaterThanOrEqual(8 * 3600_000)
        expect(until - before).toBeLessThan(8 * 3600_000 + 60_000)
    })

    it('shows the expiry and resumes in one click', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            pausedUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
        }))
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1' })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        // Stated on ③ Act itself, which is the stage being held.
        expect(await screen.findByText(/Paused for another 2h/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /Resume now/ }))

        // Explicit null, never an omitted key: only what is sent is written.
        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalledWith(
            'ds-1', { pausedUntil: null },
        ))
    })
})
