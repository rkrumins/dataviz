/**
 * Composition over time, absolute and as a share.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StackedAreaChart, type StackedSeries } from '../StackedAreaChart'

const BUCKETS = ['2026-08-21', '2026-08-22']

function s(key: string, values: number[], slot = 0): StackedSeries {
    return { key, label: key, values, slot }
}

describe('StackedAreaChart', () => {
    it('draws one band per series', () => {
        const { container } = render(
            <StackedAreaChart buckets={BUCKETS} series={[s('a', [1, 2]), s('b', [3, 4], 1)]} />,
        )
        expect(container.querySelectorAll('path[fill]').length).toBeGreaterThanOrEqual(2)
    })

    it('labels the axis in counts by default', () => {
        render(<StackedAreaChart buckets={BUCKETS} series={[s('a', [0, 100])]} />)
        expect(screen.getByRole('img')).toHaveAccessibleName(/peak/i)
    })

    it('labels the axis in percent when showing share', () => {
        // The mode exists because absolute counts hide a mix change: a graph
        // that doubled uniformly and one that doubled because a single type
        // exploded draw almost the same stack.
        render(<StackedAreaChart buckets={BUCKETS} series={[s('a', [0, 100])]} share />)
        expect(screen.getByText('100%')).toBeInTheDocument()
        expect(screen.getByRole('img')).toHaveAccessibleName(/share/i)
    })

    it('reports a series as a percentage of its bucket in share mode', () => {
        render(
            <StackedAreaChart
                buckets={BUCKETS}
                series={[s('a', [50, 25]), s('b', [50, 75], 1)]}
                share
            />,
        )
        // The readout defaults to the latest bucket: 25 of 100 is 25%.
        expect(screen.getByText('25.0%')).toBeInTheDocument()
        expect(screen.getByText('75.0%')).toBeInTheDocument()
    })

    it('marks a band that reached zero rather than letting it fade out', () => {
        // On an ordinary stacked chart a category disappearing looks exactly
        // like one shrinking. A type reaching zero is the clearest evidence
        // something deleted data, so it is drawn as a mark.
        render(
            <StackedAreaChart
                buckets={['2026-08-21', '2026-08-22', '2026-08-23']}
                series={[s('gone', [100, 40, 0]), s('kept', [10, 10, 10], 1)]}
            />,
        )
        expect(screen.getByText(/gone reached zero at/i)).toBeInTheDocument()
    })

    it('does not mark a type that came back', () => {
        // A nightly rebuild that drops and recreates a type is not an
        // incident, and marking it trains people to ignore the mark.
        render(
            <StackedAreaChart
                buckets={['2026-08-21', '2026-08-22', '2026-08-23']}
                series={[s('blip', [100, 0, 100])]}
            />,
        )
        expect(screen.queryByText(/reached zero/i)).not.toBeInTheDocument()
    })

    it('renders nothing without data', () => {
        const { container } = render(<StackedAreaChart buckets={[]} series={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})

describe('StackedAreaChart — reaching the count', () => {
    it('reports the bucket total, which the bands cannot be read off', () => {
        // Eight bands stacking to 568,091 is a number a reader can otherwise
        // only get by adding them up by hand.
        render(
            <StackedAreaChart
                buckets={BUCKETS}
                series={[s('a', [100, 300]), s('b', [50, 200], 1)]}
            />,
        )
        // Scoped: 500 is also a y-axis tick here, and both are correct.
        const label = screen.getByText('Total')
        expect(within(label.parentElement as HTMLElement).getByText('500'))
            .toBeInTheDocument()
    })

    it('keeps the count beside the share, never instead of it', () => {
        // Share alone answers "how much of the whole" and hides "how much".
        render(
            <StackedAreaChart
                buckets={BUCKETS}
                series={[s('a', [50, 750]), s('b', [50, 250], 1)]}
                share
            />,
        )
        expect(screen.getByText('750')).toBeInTheDocument()
        expect(screen.getByText('75.0%')).toBeInTheDocument()
    })
})
