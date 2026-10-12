/**
 * OverlayIntegrity — land collapsed; click opens the windowed blotter.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayIntegrity } from './OverlayIntegrity'

const { getReconciliation, getReconciliationActivity, reconcileNow, putReconciliation, permissionFn } = vi.hoisted(() => ({
    getReconciliation: vi.fn(),
    getReconciliationActivity: vi.fn(),
    reconcileNow: vi.fn(),
    putReconciliation: vi.fn(),
    permissionFn: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => permissionFn(perm),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: {
            ...actual.freshnessService,
            getReconciliation,
            getReconciliationActivity,
            reconcileNow,
            putReconciliation,
        },
    }
})

function renderCard(window: '1h' | '3h' | '12h' | '24h' | '7d' = '24h', onOpenAutomation?: () => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <OverlayIntegrity
                    summary={{
                        total: 10, ready: 8, pending: 0, failed: 0, notBuilt: 0,
                        recomputing: 0, needsAttention: 0, cacheStamped: 8,
                        drifting: 0, suspended: 0,
                    }}
                    activeFacet=""
                    onFacet={() => {}}
                    onReload={() => {}}
                    reloading={false}
                    onOpenSource={() => {}}
                    window={window}
                    onWindowChange={() => {}}
                    onOpenAutomation={onOpenAutomation}
                />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('OverlayIntegrity drift disclosure', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        permissionFn.mockReturnValue(false)
        getReconciliation.mockResolvedValue({
            policy: {
                enabled: true, checkIntervalSecs: 3600,
                envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
                envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700, allDetectors: [],
            },
            runs: [{
                id: 'rcn_live', mode: 'auto', scanned: 10, skipped: 10, seeded: 0,
                findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: { in_sync: 10 },
                startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            }],
        })
        reconcileNow.mockResolvedValue({ skipped: false, findings: [], run: null })
    })

    it('shows the Automation entry to a non-admin reader', async () => {
        // The modal renders read-only for non-admins now (settings READ is
        // ingestion-read server-side), so the entry point is no longer
        // admin-gated — hiding it made the read-only rendering unreachable
        // except by shared URL.
        getReconciliationActivity.mockResolvedValue({ since: '', items: [] })
        const onOpenAutomation = vi.fn()
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={qc}>
                <MemoryRouter>
                    <OverlayIntegrity
                        summary={null}
                        activeFacet=""
                        onFacet={() => {}}
                        onReload={() => {}}
                        reloading={false}
                        onOpenSource={() => {}}
                        window="24h"
                        onWindowChange={() => {}}
                        onOpenAutomation={onOpenAutomation}
                    />
                </MemoryRouter>
            </QueryClientProvider>,
        )
        await userEvent.click(await screen.findByRole('button', { name: /Automation/ }))
        expect(onOpenAutomation).toHaveBeenCalled()
        // The write path stays admin-only: no bulk refresh for this reader.
        expect(screen.queryByRole('button', { name: /Refresh all sources/ })).not.toBeInTheDocument()
    })

    it('lands collapsed: recency only, no window chips or source names', async () => {
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString()
        getReconciliationActivity.mockResolvedValue({
            since: sevenHoursAgo,
            items: [{
                runId: 'rcn_a',
                runStartedAt: sevenHoursAgo,
                ts: sevenHoursAgo,
                dataSourceId: 'ds-1',
                name: 'Physical Lineage 5',
                reason: 'raw_drift',
                mode: 'auto',
                outcome: 'rebuilt',
                jobId: 'agg_1',
                evidence: {},
            }],
        })
        renderCard()
        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Last drift/i })).toBeInTheDocument()
        })
        expect(screen.getByRole('button', { name: /Last drift/i })).toHaveAttribute(
            'aria-expanded', 'false',
        )
        expect(screen.queryByText('Physical Lineage 5')).not.toBeInTheDocument()
        expect(screen.queryByRole('group', { name: 'Drift window' })).not.toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Last pass' })).not.toBeInTheDocument()
        expect(getReconciliationActivity).toHaveBeenCalled()
    })

    it('opens the blotter with window chips and last-pass findings on click', async () => {
        const user = userEvent.setup()
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString()
        getReconciliationActivity.mockResolvedValue({
            since: sevenHoursAgo,
            items: [{
                runId: 'rcn_a',
                runStartedAt: sevenHoursAgo,
                ts: sevenHoursAgo,
                dataSourceId: 'ds-1',
                name: 'Physical Lineage 5',
                reason: 'raw_drift',
                mode: 'auto',
                outcome: 'rebuilt',
                jobId: 'agg_1',
                evidence: {},
            }],
        })
        renderCard('12h')
        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Last drift/i })).toBeInTheDocument()
        })
        await user.click(screen.getByRole('button', { name: /Last drift/i }))
        expect(screen.getByRole('group', { name: 'Drift window' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Last pass' })).toBeInTheDocument()
        expect(screen.getByText('Physical Lineage 5')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '12h' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('keeps Last drift from the week when the selected chip would exclude it', async () => {
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString()
        getReconciliationActivity.mockResolvedValue({
            since: sevenHoursAgo,
            items: [{
                runId: 'rcn_a',
                runStartedAt: sevenHoursAgo,
                ts: sevenHoursAgo,
                dataSourceId: 'ds-1',
                name: 'Physical Lineage 5',
                reason: 'raw_drift',
                mode: 'auto',
                outcome: 'rebuilt',
                jobId: 'agg_1',
                evidence: {},
            }],
        })
        // 1h chip would exclude a 7h-old finding from the blotter, but not the recency line.
        renderCard('1h')
        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Last drift/i })).toBeInTheDocument()
        })
        expect(screen.queryByText(/No drift in 7 days/i)).not.toBeInTheDocument()
    })
})


describe('OverlayIntegrity fleet-wide hold banner', () => {
    const POLICY = {
        enabled: true, checkIntervalSecs: 3600,
        envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
        envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700, allDetectors: [],
    }

    beforeEach(() => {
        vi.clearAllMocks()
        getReconciliationActivity.mockResolvedValue({ since: '', items: [] })
        reconcileNow.mockResolvedValue({ skipped: false, findings: [], run: null })
        putReconciliation.mockResolvedValue(POLICY)
    })

    it('says nothing when the fleet is not held', async () => {
        permissionFn.mockReturnValue(true)
        getReconciliation.mockResolvedValue({ policy: POLICY, runs: [] })
        renderCard()
        await screen.findByRole('button', { name: /check now/i })
        expect(screen.queryByText(/fleet-wide/)).not.toBeInTheDocument()
    })

    it('banners a stopped fleet above everything, and Resume lifts it', async () => {
        permissionFn.mockReturnValue(true)
        getReconciliation.mockResolvedValue({
            policy: { ...POLICY, stoppedAt: '2026-09-01T00:00:00+00:00' }, runs: [],
        })
        renderCard()

        expect(await screen.findByText(/Automatic rebuilds are stopped fleet-wide/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /resume fleet-wide/i }))
        await waitFor(() => expect(putReconciliation).toHaveBeenCalledWith({ pausedUntil: null, stopped: false }))
    })

    it('banners ③ Act off as the reason and points at Automation, not at a Resume that could not release it', async () => {
        permissionFn.mockReturnValue(true)
        getReconciliation.mockResolvedValue({
            policy: { ...POLICY, heldBy: 'fleet', heldKind: 'stopped', heldReason: 'act' }, runs: [],
        })
        const onOpenAutomation = vi.fn()
        renderCard('24h', onOpenAutomation)

        expect(await screen.findByText(/③ Act is off in Automation/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /resume fleet-wide/i })).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /open automation/i }))
        expect(onOpenAutomation).toHaveBeenCalledTimes(1)
    })

    it('a stop the server resolved from the fleet row still gets Resume', async () => {
        permissionFn.mockReturnValue(true)
        getReconciliation.mockResolvedValue({
            policy: {
                ...POLICY, stoppedAt: '2026-09-01T00:00:00+00:00',
                heldBy: 'fleet', heldKind: 'stopped', heldReason: 'hold',
            },
            runs: [],
        })
        renderCard()

        expect(await screen.findByText(/Automatic rebuilds are stopped fleet-wide\./)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /resume fleet-wide/i })).toBeInTheDocument()
    })

    it('banners a paused fleet with the time left, read-only for a non-admin', async () => {
        permissionFn.mockReturnValue(false)
        getReconciliation.mockResolvedValue({
            policy: { ...POLICY, pausedUntil: new Date(Date.now() + 3 * 3600_000).toISOString() }, runs: [],
        })
        renderCard()

        expect(await screen.findByText(/paused for another 3h fleet-wide/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /resume fleet-wide/i })).not.toBeInTheDocument()
    })
})
