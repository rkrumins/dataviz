/**
 * The evidence derivation is shared by the Freshness drawer's activity trail
 * and Job History's job detail — the two ends of the same audit trail. If they
 * ever disagreed about what a number means, the trail stops being evidence.
 * These pin the rules that make it readable.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import {
    EvidencePair, ReconcileWhy, reconcileEvidenceRows,
} from './reconcileEvidence'

const FULL = {
    expectedAggregatedEdges: 1_204_318,
    observedAggregatedEdges: 0,
    rawNodeCountBefore: 812_431,
    rawNodeCountAfter: 812_431,
    rawEdgeCountBefore: 903_118,
    rawEdgeCountAfter: 951_002,
    statsAsOf: '2026-08-14T09:12:00.000Z',
}

describe('reconcileEvidenceRows', () => {
    it('drops raw counts that did not move', () => {
        const rows = reconcileEvidenceRows(FULL)
        // Nodes are identical before and after — listing them buries the two
        // lines that are actually evidence.
        expect(rows.map(r => r.label)).toEqual(['Rolled-up edges', 'Edges'])
    })

    it('keeps rollups even when unchanged, because that IS the measurement', () => {
        // overlay_shrunk compares observed against expected; both being equal
        // is the comparison, not the absence of one.
        const rows = reconcileEvidenceRows({
            expectedAggregatedEdges: 500, observedAggregatedEdges: 500,
        })
        expect(rows).toEqual([
            { label: 'Rolled-up edges', before: 500, after: 500 },
        ])
    })

    it('omits rollups entirely when no prior build existed', () => {
        // A never_aggregated finding has no expected count; showing "0 → 0"
        // would imply a measurement that was never taken.
        expect(reconcileEvidenceRows({
            expectedAggregatedEdges: 0, observedAggregatedEdges: 0,
        })).toEqual([])
    })

    it('survives absent, empty and malformed evidence', () => {
        expect(reconcileEvidenceRows(null)).toEqual([])
        expect(reconcileEvidenceRows(undefined)).toEqual([])
        expect(reconcileEvidenceRows({})).toEqual([])
        // A non-numeric value must be skipped, not rendered as "NaN".
        expect(reconcileEvidenceRows({
            expectedAggregatedEdges: 'lots', observedAggregatedEdges: 0,
        })).toEqual([])
    })
})

describe('EvidencePair', () => {
    it('shows the delta and its direction', () => {
        render(<EvidencePair before={1000} after={800} />)
        expect(screen.getByText('1,000')).toBeInTheDocument()
        expect(screen.getByText('800')).toBeInTheDocument()
        expect(screen.getByText('(-200)')).toBeInTheDocument()
    })

    it('omits the delta when nothing changed', () => {
        const { container } = render(<EvidencePair before={500} after={500} />)
        expect(container.textContent).not.toMatch(/\(/)
    })
})

describe('ReconcileWhy', () => {
    const renderIt = (props = {}) => render(
        <MemoryRouter>
            <ReconcileWhy
                reason="overlay_missing"
                evidence={FULL}
                dataSourceId="ds_1"
                {...props}
            />
        </MemoryRouter>,
    )

    it('says nobody started it — the question the trigger source raises', () => {
        renderIt()
        expect(screen.getByText(/No one started this/i)).toBeInTheDocument()
    })

    it('names the detector in plain language, never its code', () => {
        renderIt()
        expect(screen.getByText(/rollups were missing/i)).toBeInTheDocument()
        expect(screen.queryByText(/overlay_missing/)).not.toBeInTheDocument()
    })

    it('carries the reader through to the cockpit for that source', () => {
        renderIt()
        expect(screen.getByRole('link', { name: /Open in Freshness/i }))
            .toHaveAttribute('href', '/ingestion?tab=freshness&fds=ds_1')
    })

    it('renders without evidence rather than breaking the job row', () => {
        renderIt({ evidence: null, reason: null })
        expect(screen.getByText(/Queued automatically/i)).toBeInTheDocument()
    })
})
