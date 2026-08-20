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
        lane: 'probe', capture_reason: 'changed',
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

    it('marks a material drop and reports it to the caller', async () => {
        const dropped = [
            POINTS[0],
            point({
                at: '2026-08-19T00:00:00Z', node_count: 5, node_delta: -95,
                entity_type_counts: { Table: 5 },
            }),
            POINTS[2],
        ]
        const onDropSelect = vi.fn()
        render(
            <CountTimeline
                points={dropped} grain="day" mode="total" onDropSelect={onDropSelect}
            />,
        )
        const marker = screen.getByRole('button', { name: /drop of −95/i })
        await userEvent.click(marker)
        expect(onDropSelect).toHaveBeenCalledWith('2026-08-19T00:00:00Z')
    })

    it('does not mark ordinary churn as a drop', () => {
        const churn = [
            POINTS[0],
            point({ at: '2026-08-19T00:00:00Z', node_count: 99, node_delta: -1 }),
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
