/**
 * The previous period is a COLUMN, not a tick.
 *
 * It was a hairline rule across each band, suppressed wherever the previous
 * value was zero. On a sparse window — most buckets empty, which is the normal
 * shape of "things created per day" — that left a field of floating dashes
 * with one real bar among them, and the chart read as broken rather than as
 * quiet. These lock the shape of the fix, not its styling.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { BarSeriesChart } from '../BarSeriesChart'

// The palette is resolved from `matchMedia`; jsdom has none.
beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const BUCKETS = ['2026-06-13', '2026-06-14', '2026-06-15']

/** Every column — current or previous — is drawn by the same path builder, so
 *  counting paths counts columns. */
function columns(container: HTMLElement): number {
    return container.querySelectorAll('svg path').length
}

describe('BarSeriesChart', () => {
    it('draws a column for every previous value, not a tick', () => {
        const { container } = render(
            <BarSeriesChart
                buckets={BUCKETS} values={[1, 0, 0]} previous={[3, 0, 5]} label="views"
            />,
        )
        // One current column, two previous ones. A bucket that is zero in both
        // periods draws nothing at all — a zero-height bar is not a mark.
        expect(columns(container)).toBe(3)
    })

    it('reserves no column for a comparison that is entirely zero', () => {
        const { container } = render(
            <BarSeriesChart
                buckets={BUCKETS} values={[1, 2, 3]} previous={[0, 0, 0]} label="views"
            />,
        )
        expect(columns(container)).toBe(3)
    })

    it('still plots the current period when nothing happened in it', () => {
        // The case that started this: one lonely bar, or none, against a busy
        // period before it. The comparison is the entire story here.
        const { container } = render(
            <BarSeriesChart
                buckets={BUCKETS} values={[0, 0, 0]} previous={[4, 6, 2]} label="views"
            />,
        )
        expect(columns(container)).toBe(3)
    })

    it('announces both periods on every bucket', () => {
        render(
            <BarSeriesChart
                buckets={BUCKETS} values={[1, 0, 0]} previous={[3, 0, 5]} label="views"
            />,
        )
        // Matched on the numbers, not the date: the label formats the day
        // with the reader's locale, and a test that pinned one would fail on
        // a machine set to another.
        expect(screen.getByRole('button', { name: /: 1 views, previously 3$/ }))
            .toBeInTheDocument()
    })

    it('ignores a comparison that does not line up with the axis', () => {
        const { container } = render(
            <BarSeriesChart
                buckets={BUCKETS} values={[1, 1, 1]} previous={[9, 9]} label="views"
            />,
        )
        // Three current columns and no ghost: a misaligned series would put
        // last Tuesday's number beside this Monday's.
        expect(columns(container)).toBe(3)
        expect(screen.getAllByRole('button', { name: /: 1 views$/ }))
            .toHaveLength(3)
    })
})
