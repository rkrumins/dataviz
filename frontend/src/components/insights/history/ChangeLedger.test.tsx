import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ChangeLedger } from './ChangeLedger'
import type { HistoryEvent, HistoryPoint } from '@/types/insights'

function point(over: Partial<HistoryPoint> & { at: string }): HistoryPoint {
    return {
        node_count: 0, edge_count: 0,
        entity_type_counts: {}, edge_type_counts: {},
        node_delta: null, edge_delta: null, node_min: null, node_max: null,
        lane: 'probe', capture_reason: 'changed', significance: 'normal',
        ...over,
    }
}

describe('ChangeLedger', () => {
    it('omits heartbeat rows — they are continuity, not events', () => {
        const points = [
            point({ at: '2026-08-18T10:00:00Z', node_count: 10, capture_reason: 'first' }),
            point({ at: '2026-08-18T11:00:00Z', node_count: 10, capture_reason: 'heartbeat' }),
            point({ at: '2026-08-18T12:00:00Z', node_count: 20, node_delta: 10 }),
        ]
        render(<ChangeLedger points={points} />)
        expect(screen.getAllByRole('button')).toHaveLength(2)
    })

    it('says so plainly when nothing changed', () => {
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T11:00:00Z', capture_reason: 'heartbeat' }),
        ]} />)
        expect(screen.getByText(/nothing changed in this window/i)).toBeInTheDocument()
        expect(screen.getByText(/that is a finding, not a gap/i)).toBeInTheDocument()
    })

    it('names the lane that observed each change', () => {
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T10:00:00Z', node_count: 10, capture_reason: 'first' }),
            point({ at: '2026-08-18T12:00:00Z', node_count: 20, node_delta: 10, lane: 'sweep' }),
        ]} />)
        expect(screen.getByText('Sweep')).toBeInTheDocument()
        expect(screen.getByText('Probe')).toBeInTheDocument()
    })

    it('summarises a label disappearing', () => {
        render(<ChangeLedger points={[
            point({
                at: '2026-08-18T10:00:00Z', node_count: 90,
                entity_type_counts: { Table: 50, Column: 40 }, capture_reason: 'first',
            }),
            point({
                at: '2026-08-18T12:00:00Z', node_count: 50, node_delta: -40,
                entity_type_counts: { Table: 50 },
            }),
        ]} />)
        expect(screen.getByText(/1 label disappeared/i)).toBeInTheDocument()
    })

    it('expands to the before → after breakdown', async () => {
        render(<ChangeLedger points={[
            point({
                at: '2026-08-18T10:00:00Z', node_count: 90,
                entity_type_counts: { Table: 50, Column: 40 }, capture_reason: 'first',
            }),
            point({
                at: '2026-08-18T12:00:00Z', node_count: 50, node_delta: -40,
                entity_type_counts: { Table: 50 },
            }),
        ]} />)
        await userEvent.click(screen.getAllByRole('button')[0])
        expect(screen.getByText('Column')).toBeInTheDocument()
        expect(screen.getByText('40 → 0')).toBeInTheDocument()
    })

    it('auto-expands the entry a drop marker points at', () => {
        render(<ChangeLedger
            points={[
                point({
                    at: '2026-08-18T10:00:00Z', node_count: 90,
                    entity_type_counts: { Table: 50, Column: 40 }, capture_reason: 'first',
                }),
                point({
                    at: '2026-08-18T12:00:00Z', node_count: 50, node_delta: -40,
                    entity_type_counts: { Table: 50 },
                }),
            ]}
            highlightAt="2026-08-18T12:00:00Z"
        />)
        expect(screen.getByText('40 → 0')).toBeInTheDocument()
    })

    it('claims no delta on the first snapshot', () => {
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T10:00:00Z', node_count: 90, capture_reason: 'first' }),
        ]} />)
        expect(screen.getByText('—')).toBeInTheDocument()
        expect(screen.getByText(/history starts here/i)).toBeInTheDocument()
    })
})


function event(over: Partial<HistoryEvent> & { id: string; ts: string }): HistoryEvent {
    return {
        origin: 'reconcile-sweep', actor: 'internal', scope: 'auto',
        outcome: 'accepted', gate: 'changed', reason: null, detail: null,
        job_id: null, run_id: null,
        ...over,
    }
}

const DROP = [
    point({
        at: '2026-08-18T10:00:00Z', node_count: 900,
        entity_type_counts: { Table: 900 }, capture_reason: 'first',
    }),
    point({
        at: '2026-08-18T12:00:00Z', node_count: 40, node_delta: -860,
        entity_type_counts: { Table: 40 }, significance: 'severe',
    }),
]

describe('ChangeLedger — significance', () => {
    it('badges a movement outside the source\u2019s normal range', () => {
        render(<ChangeLedger points={DROP} />)
        expect(screen.getByText('severe')).toBeInTheDocument()
    })

    it('badges a wipe as critical, not as the tier below it', () => {
        // Regression: every consumer used to compare `=== 'severe'`, so a
        // `critical` point fell through to the notable styling — the worst
        // event in the window drawn as the mildest.
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T10:00:00Z', node_count: 900_000, capture_reason: 'first' }),
            point({
                at: '2026-08-18T12:00:00Z', node_count: 100, node_delta: -899_900,
                significance: 'critical',
            }),
        ]} />)
        const chip = screen.getByText('critical')
        expect(chip).toBeInTheDocument()
        // The top tier's chip is the solid one, not the amber notable tint.
        expect(chip.className).toContain('bg-red-600')
        expect(chip.className).not.toContain('amber')
    })

    it('does not badge ordinary movement', () => {
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T10:00:00Z', node_count: 10, capture_reason: 'first' }),
            point({ at: '2026-08-18T12:00:00Z', node_count: 20, node_delta: 10 }),
        ]} />)
        expect(screen.queryByText('severe')).toBeNull()
        expect(screen.queryByText('notable')).toBeNull()
    })

    it('filters to unusual movements on request', () => {
        render(<ChangeLedger points={DROP} onlyNotable />)
        // The `first` snapshot is normal, so only the severe drop survives.
        expect(screen.getAllByRole('button')).toHaveLength(1)
    })

    it('explains an empty filtered list in the filter\u2019s own terms', () => {
        render(<ChangeLedger points={[
            point({ at: '2026-08-18T10:00:00Z', node_count: 10, capture_reason: 'first' }),
        ]} onlyNotable />)
        expect(screen.getByText(/nothing unusual in this window/i)).toBeInTheDocument()
        expect(screen.getByText(/within this source/i)).toBeInTheDocument()
    })
})

describe('ChangeLedger — correlated activity', () => {
    it('names what the platform was doing at the same moment', async () => {
        render(<ChangeLedger points={DROP} events={[
            event({
                id: 'e1', ts: '2026-08-18T12:01:00Z', reason: 'overlay_shrunk',
            }),
        ]} highlightAt="2026-08-18T12:00:00Z" />)

        expect(screen.getByText('Reconciliation sweep')).toBeInTheDocument()
        expect(screen.getByText(/overlay shrunk/)).toBeInTheDocument()
        expect(screen.getByText('accepted')).toBeInTheDocument()
    })

    it('says so when nothing of ours ran — that is the external-writer case', () => {
        render(<ChangeLedger points={DROP} events={[]}
                             highlightAt="2026-08-18T12:00:00Z" />)
        expect(screen.getByText(/came from outside/i)).toBeInTheDocument()
    })

    it('ignores activity too far from the observation to be related', () => {
        render(<ChangeLedger points={DROP} events={[
            event({ id: 'e-old', ts: '2026-08-18T06:00:00Z' }),
        ]} highlightAt="2026-08-18T12:00:00Z" />)
        expect(screen.queryByText('Reconciliation sweep')).toBeNull()
        expect(screen.getByText(/came from outside/i)).toBeInTheDocument()
    })

    it('distinguishes the two subsystems that both say "reconcile"', () => {
        render(<ChangeLedger points={DROP} events={[
            event({ id: 'e1', ts: '2026-08-18T12:01:00Z', origin: 'reconcile' }),
        ]} highlightAt="2026-08-18T12:00:00Z" />)
        expect(screen.getByText('Stale-marker reconcile')).toBeInTheDocument()
    })
})
