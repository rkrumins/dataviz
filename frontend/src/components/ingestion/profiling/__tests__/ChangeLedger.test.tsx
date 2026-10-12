/**
 * The ledger — what happened, what didn't, and over what period.
 *
 * The version this replaces dropped heartbeats silently, so a stretch where
 * nothing moved looked identical to a stretch where nothing was watching.
 * Those are opposite facts, and they lead to opposite actions.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Observation, ObservationsPayload } from '@/types/profiling'
import { ChangeLedger } from '../ChangeLedger'

function obs(over: Partial<Observation> & { at: string; id: string }): Observation {
    return {
        lane: 'probe', reason: 'changed', refresh_event_id: null,
        node_count: 1000, edge_count: 500, node_delta: 10, edge_delta: 0,
        entity_type_counts: {}, edge_type_counts: {}, type_deltas: null,
        significance: { nodes: 'normal', edges: 'normal' },
        ...over,
    }
}

function payload(
    observations: Observation[],
    counts?: Partial<ObservationsPayload['counts']>,
): ObservationsPayload {
    return {
        id: 'ds_a', from: '2026-07-25', to: '2026-08-24', window: '30d',
        observations, total: observations.length, offset: 0, limit: 50,
        baselines: { nodes: 25, edges: 25 }, events: [],
        counts: {
            observations: observations.length,
            moved: observations.filter((o) => o.reason !== 'heartbeat').length,
            checkpoints: observations.filter((o) => o.reason === 'heartbeat').length,
            runs: 0,
            ...counts,
        },
    }
}

function renderIt(p: ObservationsPayload, onlyNotable = false) {
    return render(
        <ChangeLedger
            payload={p}
            onlyNotable={onlyNotable}
            onOnlyNotable={vi.fn()}
            windowLabel="Last 30 days"
        />,
    )
}

describe('ChangeLedger', () => {
    it('names the period every number is scoped to', () => {
        // Without it a reader cannot tell "this source is stable" from "I
        // picked a 24-hour window", and those lead to opposite actions.
        renderIt(payload([obs({ id: '1', at: '2026-08-24T09:00:00Z' })], {
            observations: 214, moved: 5,
        }))
        expect(screen.getByText(/last 30 days/i)).toBeInTheDocument()
        expect(screen.getByText('214')).toBeInTheDocument()
        expect(screen.getByText('5')).toBeInTheDocument()
    })

    it('says how long it has been steady since the last movement', () => {
        renderIt(payload([
            obs({ id: 'h3', at: '2026-08-24T09:00:00Z', reason: 'heartbeat', node_delta: 0 }),
            obs({ id: 'h2', at: '2026-08-24T08:00:00Z', reason: 'heartbeat', node_delta: 0 }),
            obs({ id: 'h1', at: '2026-08-24T07:00:00Z', reason: 'heartbeat', node_delta: 0 }),
            obs({ id: 'm1', at: '2026-08-21T09:00:00Z', node_delta: 1204 }),
        ]))
        expect(screen.getByText(/steady for/i)).toBeInTheDocument()
        expect(screen.getByText('3 days')).toBeInTheDocument()
        expect(screen.getByText(/checkpoints have confirmed no movement/i)).toBeInTheDocument()
    })

    it('draws the silence between two movements', () => {
        renderIt(payload([
            obs({ id: 'm2', at: '2026-08-24T09:00:00Z', node_delta: 5 }),
            obs({ id: 'h1', at: '2026-08-24T06:00:00Z', reason: 'heartbeat', node_delta: 0 }),
            obs({ id: 'm1', at: '2026-08-24T03:00:00Z', node_delta: -890 }),
        ]))
        expect(screen.getByText(/nothing moved for 6 hours/i)).toBeInTheDocument()
        expect(screen.getByText(/1 checkpoint/i)).toBeInTheDocument()
    })

    it('reports a run that changed nothing as a finding, not a blank row', () => {
        // The loader ran and produced no movement. That is something that
        // happened, and it must not read as an empty row.
        renderIt(payload([
            obs({ id: 'r1', at: '2026-08-24T09:00:00Z', reason: 'run', node_delta: 0, edge_delta: 0 }),
        ]))
        expect(screen.getByText(/this run changed nothing/i)).toBeInTheDocument()
    })

    it('says the source was watched when nothing moved at all', () => {
        // "Nothing moved" and "nothing was watching" are opposite facts.
        renderIt(payload([], { observations: 720, moved: 0, checkpoints: 720 }))
        expect(screen.getByText(/nothing moved in the last 30 days/i)).toBeInTheDocument()
        expect(
            screen.getByText(/this source was watched and did not change/i),
        ).toBeInTheDocument()
    })

    it('distinguishes an unwatched period from a quiet one', () => {
        renderIt(payload([], { observations: 0, moved: 0, checkpoints: 0 }))
        expect(screen.getByText(/no observations were recorded/i)).toBeInTheDocument()
    })

    it('scopes its empty copy to the filter as well as the period', () => {
        renderIt(payload([], { observations: 40, moved: 0, checkpoints: 40 }), true)
        expect(screen.getByText(/nothing unusual in the last 30 days/i)).toBeInTheDocument()
        expect(screen.getByText(/clear the filter/i)).toBeInTheDocument()
    })

    it('marks the observation that starts the record', () => {
        renderIt(payload([
            obs({ id: 'f1', at: '2026-08-24T09:00:00Z', reason: 'first', node_delta: null, edge_delta: null }),
        ]))
        expect(screen.getByText(/the record starts here/i)).toBeInTheDocument()
    })
})
