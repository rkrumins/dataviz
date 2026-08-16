import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IntegrityPulse } from './IntegrityPulse'
import { checkNowToast, itemsInWindow, lastDriftAt, lastPassLabel, parseDriftWindow, pickLastPassRun, sweepsHaveStopped } from './reconcileHealth'
import type { FreshnessSummary, ReconcileActivityItem, ReconcilePolicy, ReconcileRun } from '@/services/freshnessService'

const POLICY: ReconcilePolicy = {
    enabled: true, checkIntervalSecs: 3600,
    envEnabled: true, envCheckIntervalSecs: 3600, envMaxActionsPerRun: 10,
    envShrinkTolerancePct: 10, envStatsMaxAgeSecs: 2700, allDetectors: [],
}

const SUMMARY: FreshnessSummary = {
    total: 10, ready: 8, pending: 0, failed: 0, notBuilt: 0,
    recomputing: 0, needsAttention: 3, cacheStamped: 8,
    drifting: 2, suspended: 1,
}

describe('sweepsHaveStopped', () => {
    it('is false when the last run is within 3× the interval', () => {
        const recent = new Date(Date.now() - 30 * 60_000).toISOString()
        expect(sweepsHaveStopped(recent, 3600)).toBe(false)
    })

    it('is true once the last run is older than 3× the interval', () => {
        const stale = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
        expect(sweepsHaveStopped(stale, 3600)).toBe(true)
    })

    it('is false when nothing has run yet', () => {
        expect(sweepsHaveStopped(null, 3600)).toBe(false)
    })
})

describe('lastPassLabel', () => {
    it('names checked, in sync, drifted, and queued from bySkip', () => {
        expect(lastPassLabel({
            scanned: 47, findings: 2, actions: 1,
            bySkip: { in_sync: 40, platform_mastered: 3, stats_stale: 2 },
        }, 47)).toBe(
            '47 of 47 checked · 3 versioned · 2 stats stale · 40 in sync · 2 drifted · 1 queued',
        )
    })

    it('falls back when bySkip is missing', () => {
        expect(lastPassLabel({ scanned: 47, findings: 2, actions: 1, bySkip: {} }, 47))
            .toBe('47 of 47 checked · 45 in sync · 2 drifted · 1 queued')
    })

    it('names an empty auto tick as nobody due, not an empty set', () => {
        expect(lastPassLabel({ scanned: 0, findings: 0, actions: 0, bySkip: {} }, 12))
            .toBe('no sources were due this tick')
        expect(checkNowToast({ skipped: false, run: { scanned: 0, findings: 0, actions: 0, bySkip: {} } }))
            .toBe('No sources in the reconcile set yet.')
    })

    it('defaults the drift window to 24h', () => {
        expect(parseDriftWindow(null)).toBe('24h')
        expect(parseDriftWindow('3h')).toBe('3h')
        expect(parseDriftWindow('7d')).toBe('7d')
    })
})

describe('pickLastPassRun', () => {
    it('ignores empty lastCheck when a scanned run exists', () => {
        const empty: ReconcileRun = {
            id: 'empty', mode: 'auto', scanned: 0, skipped: 0, seeded: 0,
            findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: {},
            startedAt: new Date().toISOString(),
        }
        const meaningful: ReconcileRun = {
            id: 'm', mode: 'manual', scanned: 12, skipped: 10, seeded: 0,
            findings: 2, actions: 2, errors: 0, byReason: {}, bySkip: { in_sync: 10 },
            startedAt: new Date(Date.now() - 60_000).toISOString(),
        }
        expect(pickLastPassRun([empty, meaningful])).toEqual(meaningful)
        expect(pickLastPassRun([empty, meaningful], empty)).toEqual(meaningful)
        expect(pickLastPassRun([empty])).toBeUndefined()
        expect(pickLastPassRun([empty, meaningful], meaningful)).toEqual(meaningful)
    })
})

describe('IntegrityPulse clock', () => {
    it('bases next-in on the last scanned pass, not an empty tick', () => {
        const empty: ReconcileRun = {
            id: 'empty', mode: 'auto', scanned: 0, skipped: 0, seeded: 0,
            findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: {},
            startedAt: new Date().toISOString(),
        }
        const pass: ReconcileRun = {
            id: 'pass', mode: 'manual', scanned: 5, skipped: 5, seeded: 0,
            findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: { in_sync: 5 },
            // 30 minutes ago → with 1h interval, next in ~30m
            startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        }
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={empty}
                lastPassRun={pass}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
            />,
        )
        expect(screen.getByText(/next in 30m/)).toBeInTheDocument()
        expect(screen.getByText(/last pass 5 of 10 checked · 5 in sync · 0 drifted/)).toBeInTheDocument()
    })
})

describe('lastDriftAt / itemsInWindow', () => {
    const finding = (over: Partial<ReconcileActivityItem>): ReconcileActivityItem => ({
        runId: 'rcn_a',
        runStartedAt: '2026-08-15T02:00:00Z',
        ts: '2026-08-15T02:00:00Z',
        dataSourceId: 'ds-1',
        name: 'A',
        reason: 'raw_drift',
        mode: 'auto',
        outcome: 'rebuilt',
        jobId: 'j1',
        evidence: {},
        ...over,
    })

    it('picks the newest finding time, preferring ts over runStartedAt', () => {
        const older = finding({
            ts: new Date(Date.now() - 8 * 3600_000).toISOString(),
            runStartedAt: new Date(Date.now() - 9 * 3600_000).toISOString(),
        })
        const newerTs = new Date(Date.now() - 2 * 3600_000).toISOString()
        const newer = finding({
            dataSourceId: 'ds-2',
            ts: newerTs,
            runStartedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        })
        expect(lastDriftAt([older, newer])).toBe(newerTs)
        expect(lastDriftAt([])).toBeNull()
    })

    it('filters the week payload by chip window without changing recency source', () => {
        const now = Date.now()
        const in1h = finding({
            dataSourceId: 'recent',
            ts: new Date(now - 30 * 60_000).toISOString(),
        })
        const in12h = finding({
            dataSourceId: 'mid',
            ts: new Date(now - 6 * 3600_000).toISOString(),
        })
        const in7d = finding({
            dataSourceId: 'old',
            ts: new Date(now - 3 * 24 * 3600_000).toISOString(),
        })
        const week = [in1h, in12h, in7d]
        expect(itemsInWindow(week, '1h', now).map(i => i.dataSourceId)).toEqual(['recent'])
        expect(itemsInWindow(week, '12h', now).map(i => i.dataSourceId)).toEqual(['recent', 'mid'])
        expect(itemsInWindow(week, '7d', now).map(i => i.dataSourceId)).toEqual(['recent', 'mid', 'old'])
        // Recency still sees the whole week even when the chip is 1h.
        expect(lastDriftAt(week)).toBe(in1h.ts)
    })
})

describe('IntegrityPulse history disclosure', () => {
    it('shows Last drift with TimeStamp and expands the panel on click', async () => {
        const user = userEvent.setup()
        const onToggle = vi.fn()
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString()
        const { rerender } = render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={undefined}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
                lastDriftAt={sevenHoursAgo}
                historyOpen={false}
                onToggleHistory={onToggle}
                historyPanel={<div>Blotter body</div>}
            />,
        )
        const control = screen.getByRole('button', { name: /Last drift/i })
        expect(control).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('Blotter body')).not.toBeInTheDocument()
        expect(screen.queryByText('Drift in this window')).not.toBeInTheDocument()
        await user.click(control)
        expect(onToggle).toHaveBeenCalled()

        rerender(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={undefined}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
                lastDriftAt={sevenHoursAgo}
                historyOpen
                onToggleHistory={onToggle}
                historyPanel={<div>Blotter body</div>}
            />,
        )
        expect(screen.getByRole('button', { name: /Last drift/i })).toHaveAttribute(
            'aria-expanded', 'true',
        )
        expect(screen.getByText('Blotter body')).toBeInTheDocument()
    })

    it('names an empty week without looking like an alarm', () => {
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={undefined}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
                lastDriftAt={null}
                historyOpen={false}
                onToggleHistory={() => {}}
                historyPanel={null}
            />,
        )
        expect(screen.getByRole('button', { name: /No drift in 7 days/i })).toBeInTheDocument()
    })
})

describe('IntegrityPulse', () => {
    it('goes amber and names the outage when sweeps have stopped', () => {
        const stale = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
        const run: ReconcileRun = {
            id: 'r1', mode: 'auto', scanned: 12, skipped: 10, seeded: 0,
            findings: 2, actions: 2, errors: 0, byReason: {}, bySkip: { in_sync: 10 },
            startedAt: stale,
        }
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={run}
                lastPassRun={run}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
            />,
        )
        expect(screen.getByText('Sweeps have stopped')).toBeInTheDocument()
        expect(screen.getByText(/2 drifting/)).toBeInTheDocument()
        expect(screen.getByText(/1 held by the breaker/)).toBeInTheDocument()
        expect(screen.getByText(/last pass 12 of 12 checked · 10 in sync · 2 drifted · 2 queued/)).toBeInTheDocument()
    })

    it('omits last pass when no meaningful run exists', () => {
        const empty: ReconcileRun = {
            id: 'r0', mode: 'auto', scanned: 0, skipped: 0, seeded: 0,
            findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: {},
            startedAt: new Date().toISOString(),
        }
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={empty}
                lastPassRun={undefined}
                isError={false}
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
            />,
        )
        expect(screen.queryByText(/last pass/)).not.toBeInTheDocument()
    })

    it('renders a recon error instead of looking healthy', () => {
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={undefined}
                isError
                isLoading={false}
                isAdmin={false}
                onCheckNow={() => {}}
                checking={false}
                onPreview={() => {}}
                onFacet={() => {}}
                activeFacet=""
            />,
        )
        expect(screen.getByRole('alert')).toHaveTextContent(/could not load overlay integrity/i)
        expect(screen.queryByText('Sweeps have stopped')).not.toBeInTheDocument()
    })
})
