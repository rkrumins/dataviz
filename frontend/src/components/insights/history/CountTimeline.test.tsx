import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CountTimeline, TimelineLegend } from './CountTimeline'
import type { HistoryPoint } from '@/types/insights'

function point(over: Partial<HistoryPoint> & { at: string }): HistoryPoint {
    return {
        node_count: 0, edge_count: 0,
        entity_type_counts: {}, edge_type_counts: {},
        node_delta: null, edge_delta: null, node_min: null, node_max: null,
        lane: 'probe', capture_reason: 'changed', significance: 'normal',
        ...over,
    }
}

const POINTS: HistoryPoint[] = [
    point({ at: '2026-08-18T00:00:00Z', node_count: 100, entity_type_counts: { Table: 60, Column: 40 } }),
    point({ at: '2026-08-19T00:00:00Z', node_count: 120, node_delta: 20, entity_type_counts: { Table: 70, Column: 50 } }),
    point({ at: '2026-08-20T00:00:00Z', node_count: 130, node_delta: 10, entity_type_counts: { Table: 80, Column: 50 } }),
]

describe('CountTimeline', () => {
    it('renders nothing below two points — there is no trend to draw', () => {
        const { container } = render(
            <CountTimeline points={[POINTS[0]]} grain="raw" mode="total" />,
        )
        expect(container.querySelector('svg')).toBeNull()
    })

    it('draws one stacked band per label in composition mode', () => {
        const { container } = render(
            <CountTimeline points={POINTS} grain="day" mode="composition" />,
        )
        // Two labels → two filled areas.
        expect(container.querySelectorAll('path[fill-opacity]').length).toBe(2)
    })

    it('draws a single line in total mode', () => {
        const { container } = render(
            <CountTimeline points={POINTS} grain="day" mode="total" />,
        )
        expect(container.querySelectorAll('polyline').length).toBe(1)
    })

    it('shows the latest observation in the read-out by default', () => {
        render(<CountTimeline points={POINTS} grain="day" mode="total" />)
        expect(screen.getByText('130')).toBeInTheDocument()
        expect(
            screen.getByText(/hover the chart to inspect any point/i),
        ).toBeInTheDocument()
    })

    it('marks a drop the server judged unusual and reports it to the caller', async () => {
        const dropped = [
            POINTS[0],
            point({
                at: '2026-08-19T00:00:00Z', node_count: 5, node_delta: -95,
                entity_type_counts: { Table: 5 }, significance: 'severe',
            }),
            POINTS[2],
        ]
        const onDropSelect = vi.fn()
        render(
            <CountTimeline
                points={dropped} grain="day" mode="total" onDropSelect={onDropSelect}
            />,
        )
        const marker = screen.getByRole('button', { name: /severe drop of −95/i })
        await userEvent.click(marker)
        expect(onDropSelect).toHaveBeenCalledWith('2026-08-19T00:00:00Z')
    })

    it('marks an unusual RISE too — a runaway loader is also a failure', () => {
        const spike = [
            POINTS[0],
            point({
                at: '2026-08-19T00:00:00Z', node_count: 900_000,
                node_delta: 899_900, significance: 'severe',
            }),
            POINTS[2],
        ]
        // A marker only claims to be a button when it is actionable — without
        // a handler it is a mark, not a control.
        render(
            <CountTimeline
                points={spike} grain="day" mode="total" onDropSelect={vi.fn()}
            />,
        )
        expect(screen.getByRole('button', { name: /severe rise of/i })).toBeInTheDocument()
    })

    it('leaves movement the server called normal unmarked, however large', () => {
        // A big number that is ordinary FOR THIS SOURCE. A fixed threshold
        // would have marked it; the per-source baseline does not.
        const churn = [
            POINTS[0],
            point({ at: '2026-08-19T00:00:00Z', node_count: 5, node_delta: -95 }),
            POINTS[2],
        ]
        render(<CountTimeline points={churn} grain="day" mode="total" />)
        expect(screen.queryByRole('button', { name: /drop of/i })).toBeNull()
    })

    it('renders one mini-chart per label in compare mode', () => {
        const { container } = render(
            <CountTimeline points={POINTS} grain="day" mode="compare" />,
        )
        expect(container.querySelectorAll('svg').length).toBe(2)
        expect(screen.getByText('Table')).toBeInTheDocument()
        expect(screen.getByText('Column')).toBeInTheDocument()
    })

    it('carries an accessible description of the series', () => {
        render(<CountTimeline points={POINTS} grain="day" mode="total" />)
        expect(
            screen.getByRole('img', { name: /3 observations, 100 to 130/i }),
        ).toBeInTheDocument()
    })
})

describe('TimelineLegend', () => {
    it('flags a label that appeared and one that disappeared', () => {
        const points: HistoryPoint[] = [
            point({ at: '2026-08-18T00:00:00Z', node_count: 40, entity_type_counts: { Legacy: 40 } }),
            point({ at: '2026-08-20T00:00:00Z', node_count: 30, entity_type_counts: { Fresh: 30 } }),
        ]
        render(<TimelineLegend points={points} />)
        expect(screen.getByText('new')).toBeInTheDocument()
        expect(screen.getByText('gone')).toBeInTheDocument()
    })
})

describe('CountTimeline \u2014 the worst tier is the loudest', () => {
    it('names a critical drop critical, and does not dim its marker', () => {
        // `critical` outranks `severe`; the marker used to dim anything that
        // was not literally 'severe', which drew a wipe more faintly than a dip.
        const wiped = [
            POINTS[0],
            point({
                at: '2026-08-19T00:00:00Z', node_count: 100, node_delta: -899_900,
                entity_type_counts: { Table: 100 }, significance: 'critical',
            }),
            POINTS[2],
        ]
        render(
            <CountTimeline
                points={wiped} grain="day" mode="total" onDropSelect={vi.fn()}
            />,
        )
        const marker = screen.getByRole('button', { name: /critical drop of/i })
        expect(marker.querySelector('polygon')?.getAttribute('class'))
            .not.toContain('opacity-60')
    })

    it('still dims a merely-notable marker, so the tiers stay distinguishable', () => {
        const dip = [
            POINTS[0],
            point({
                at: '2026-08-19T00:00:00Z', node_count: 80, node_delta: -20,
                entity_type_counts: { Table: 80 }, significance: 'notable',
            }),
            POINTS[2],
        ]
        render(
            <CountTimeline
                points={dip} grain="day" mode="total" onDropSelect={vi.fn()}
            />,
        )
        const marker = screen.getByRole('button', { name: /notable drop of/i })
        expect(marker.querySelector('polygon')?.getAttribute('class'))
            .toContain('opacity-60')
    })
})
