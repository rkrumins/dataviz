/**
 * The Automation panel — the three-stage pipeline (① Detect → ② Check → ③ Act)
 * that replaced the cadence modal, plus the vocabulary and contradiction rules
 * it speaks. The save tests came verbatim from CadenceControls' popover block:
 * the panel writes the same two records in the same order.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { automationWarnings } from './automationCopy'

const {
    getAggregationSettings, putAggregationCadence, listJobsGlobal, permissionFn,
    getReconciliation, putReconciliation, reconcileNow,
} = vi.hoisted(() => ({
    getAggregationSettings: vi.fn(),
    putAggregationCadence: vi.fn(),
    listJobsGlobal: vi.fn(),
    permissionFn: vi.fn(),
    getReconciliation: vi.fn(),
    putReconciliation: vi.fn(),
    reconcileNow: vi.fn(),
}))

/** The reconciliation policy shares the panel and the stored record with the
 *  rebuild cadence, so every cadence test needs it resolvable. */
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

import { AutomationPanel } from './AutomationPanel'

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
    getReconciliation.mockResolvedValue({ policy: RECON_POLICY, runs: [] })
    putReconciliation.mockResolvedValue(RECON_POLICY)
    // The impact line fires a debounced dry sweep; keep it resolvable so a
    // slow assertion cannot land on an unmocked promise.
    reconcileNow.mockResolvedValue({ run: null, findings: [], skipped: false })
})

describe('automationWarnings', () => {
    it('warns that checks are only as fresh as the slow refresh when detect is off', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: false },
        )
        expect(w.map(x => x.id)).toContain('detect-off')
        expect(w[0].text).toMatch(/only see data as fresh as/i)
    })

    it('warns when every detector is unchecked', () => {
        const w = automationWarnings(
            { enabled: true, detectors: [] },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('no-detectors')
    })

    it('treats an unset detector list as all-on, not none', () => {
        // null = "all enabled"; [] = "act on nothing". Never truthiness.
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).not.toContain('no-detectors')
    })

    it('warns when the action cap is zero', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 0 },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('cap-zero')
    })

    it('is silent on a healthy policy', () => {
        expect(automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 10 },
            { probeEnabled: true },
        )).toEqual([])
    })
})

describe('AutomationPanel', () => {
    it('renders read-only without system:admin', async () => {
        wrap(<AutomationPanel open onToggle={() => {}} isAdmin={false} summary={null} />)

        expect(await screen.findByText(/Detect/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '5m' })).toBeDisabled()
        // The cadence record is admin-only to READ, so a non-admin must not
        // fire a request that can only 403.
        expect(getAggregationSettings).not.toHaveBeenCalled()
    })

    it('collapsed, it speaks one sentence and nothing else', async () => {
        wrap(<AutomationPanel open={false} onToggle={() => {}} isAdmin summary={null} />)

        expect(await screen.findByText(/Checking every 1 hour/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '5m' })).not.toBeInTheDocument()
    })
})

/** Moved verbatim (assertions unchanged) from CadenceControls' `admin cadence
 *  popover` block when the dialog was deleted. The panel is the editor now, so
 *  only how the values are reached changed — a DurationField in seconds
 *  instead of a bare minutes box. */
describe('admin automation save', () => {
    it('seeds from the persisted cadence and Save fires the cadence PUT', async () => {
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: { rebuildMinIntervalSecs: 600, driftAutoRebuild: false },
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
            envProbeEnabled: true, envProbeIntervalSecs: 60,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: { rebuildMinIntervalSecs: 120, driftAutoRebuild: false } })
        wrap(<AutomationPanel open onToggle={() => {}} isAdmin summary={null} />)

        const input = await screen.findByLabelText('Minimum time between rebuilds (custom, seconds)')
        // Seeded straight from the stored 600s — no minutes/seconds arithmetic
        // for the reader, which is the whole point of the shared control.
        await waitFor(() => expect(input).toHaveValue(600))

        await userEvent.clear(input)
        await userEvent.type(input, '120')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            {
                rebuildMinIntervalSecs: 120, driftAutoRebuild: false,
                probeEnabled: true, probeIntervalSecs: null,
            },
        ))
    })

    it('no persisted cadence: a plain Save round-trips the env defaults (no drift clobber)', async () => {
        // Deploy env has drift-auto and change-detection OFF, and no persisted
        // cadence. Both toggles must seed from their env default (false), so an
        // interval-only Save does NOT switch either on fleet-wide. Every toggle
        // added to this panel inherits the same hazard, hence both here.
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: null,
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: false,
            envProbeEnabled: false, envProbeIntervalSecs: 60,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: null })
        wrap(<AutomationPanel open onToggle={() => {}} isAdmin summary={null} />)

        const toggle = await screen.findByLabelText(/Automatically rebuild a source when drift is detected/i)
        await waitFor(() => expect(toggle).not.toBeChecked())

        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            {
                rebuildMinIntervalSecs: null, driftAutoRebuild: false,
                probeEnabled: false, probeIntervalSecs: null,
            },
        ))
    })

    it('says out loud that a check cannot outrun a detector that is off', async () => {
        // The dependency the modal hid: Detect feeds Check, so Detect off
        // makes the Check interval a promise nobody can keep.
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: null,
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
            envProbeEnabled: false, envProbeIntervalSecs: 60,
        })
        wrap(<AutomationPanel open onToggle={() => {}} isAdmin summary={null} />)

        expect(await screen.findByText(/only see data as fresh as/i)).toBeInTheDocument()
    })
})
