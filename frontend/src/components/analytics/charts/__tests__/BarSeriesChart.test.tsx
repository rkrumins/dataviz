/**
 * The previous period is drawn on the SAME axis, in chronological position.
 *
 * It was a hairline tick first, which vanished into a field of floating dashes
 * on a sparse window. Then a paired column, which was legible but was placed
 * by bucket INDEX against an axis labelled with the CURRENT period's dates —
 * so a bar for the 4th of July sat on the 3rd of August. These lock the layout
 * that makes the axis tell the truth, not the styling on top of it.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { BarSeriesChart } from '../BarSeriesChart'
import { shortDate } from '@/lib/formatMetric'

// The palette is resolved from `matchMedia`; jsdom has none.
beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const NOW = ['2026-06-13', '2026-06-14', '2026-06-15']
const BEFORE = ['2026-06-10', '2026-06-11', '2026-06-12']

/** Every column is drawn by the same path builder, so counting paths counts
 *  columns. A bucket that is zero draws nothing — a zero-height bar is not a
 *  mark. */
function columns(container: HTMLElement): number {
    return container.querySelectorAll('svg path').length
}

describe('BarSeriesChart', () => {
    it('puts every bar on the date it actually happened', () => {
        render(
            <BarSeriesChart
                buckets={NOW} values={[1, 0, 0]}
                previous={{ buckets: BEFORE, values: [3, 0, 5] }}
                previousLabel="Previous 3 days"
                label="views"
            />,
        )
        // Built with the app's own formatter, so the expectation holds on a
        // machine set to any locale.
        const names = screen.getAllByRole('button')
            .map((b) => b.getAttribute('aria-label'))

        // The previous period's 5 belongs to 12 June and sits third on the
        // axis. Under the old layout it was the SIXTH bar, drawn on 15 June —
        // this period's last day — which is the bug this locks out.
        expect(names[2]).toBe(`${shortDate('2026-06-12', true)}: 5 views (previous 3 days)`)
        expect(names[3]).toBe(`${shortDate('2026-06-13', true)}: 1 views`)
    })

    it('draws one column per non-empty bucket across both periods', () => {
        const { container } = render(
            <BarSeriesChart
                buckets={NOW} values={[1, 0, 0]}
                previous={{ buckets: BEFORE, values: [3, 0, 5] }}
                label="views"
            />,
        )
        expect(columns(container)).toBe(3)
        // Six buckets on the axis, not three: the axis covers both periods.
        expect(screen.getAllByRole('button')).toHaveLength(6)
    })

    it('still plots the current period when nothing happened in it', () => {
        // The case that started this: no views created this month, plenty last
        // month. The comparison is the entire story.
        const { container } = render(
            <BarSeriesChart
                buckets={NOW} values={[0, 0, 0]}
                previous={{ buckets: BEFORE, values: [4, 6, 2] }}
                label="views"
            />,
        )
        expect(columns(container)).toBe(3)
    })

    it('names which period a bar belongs to, for a screen reader too', () => {
        render(
            <BarSeriesChart
                buckets={NOW} values={[1, 1, 1]}
                previous={{ buckets: BEFORE, values: [2, 2, 2] }}
                previousLabel="Previous 3 days"
                label="views"
            />,
        )
        expect(screen.getAllByRole('button', { name: /\(previous 3 days\)$/ }))
            .toHaveLength(3)
        expect(screen.getAllByRole('button', { name: /: 1 views$/ })).toHaveLength(3)
    })

    it('ignores a comparison whose dates and values disagree', () => {
        render(
            <BarSeriesChart
                buckets={NOW} values={[1, 1, 1]}
                previous={{ buckets: BEFORE, values: [9, 9] }}
                label="views"
            />,
        )
        // Three buckets, not five-and-a-half: a comparison that cannot be
        // placed is not placed at all.
        expect(screen.getAllByRole('button')).toHaveLength(3)
    })

    it('draws a plain single-period chart when there is nothing to compare', () => {
        const { container } = render(
            <BarSeriesChart buckets={NOW} values={[1, 2, 3]} label="views" />,
        )
        expect(columns(container)).toBe(3)
        expect(screen.getAllByRole('button')).toHaveLength(3)
    })
})
