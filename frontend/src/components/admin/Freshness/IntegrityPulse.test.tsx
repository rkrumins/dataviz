import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IntegrityPulse } from './IntegrityPulse'
import { sweepsHaveStopped } from './reconcileHealth'
import type { FreshnessSummary, ReconcilePolicy, ReconcileRun } from '@/services/freshnessService'

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

describe('IntegrityPulse', () => {
    it('goes amber and names the outage when sweeps have stopped', () => {
        const stale = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
        const run: ReconcileRun = {
            id: 'r1', mode: 'auto', scanned: 12, skipped: 10, seeded: 0,
            findings: 2, actions: 2, errors: 0, byReason: {}, bySkip: {},
            startedAt: stale,
        }
        render(
            <IntegrityPulse
                summary={SUMMARY}
                policy={POLICY}
                latestRun={run}
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
        expect(screen.getByText(/1 needs a person/)).toBeInTheDocument()
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
