import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ChangeLedger } from './ChangeLedger'
import type { HistoryPoint } from '@/types/insights'

function point(over: Partial<HistoryPoint> & { at: string }): HistoryPoint {
    return {
        node_count: 0, edge_count: 0,
        entity_type_counts: {}, edge_type_counts: {},
        node_delta: null, edge_delta: null, node_min: null, node_max: null,
        lane: 'probe', capture_reason: 'changed',
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
