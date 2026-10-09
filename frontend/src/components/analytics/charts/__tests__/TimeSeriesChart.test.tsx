/**
 * The y-scale is the one part of a chart that can lie without looking wrong.
 *
 * A floor above the data clips a series into the chrome; a floor below it
 * flattens the shape. `baseline` exists for indexed measures, where 100 — not
 * zero — is the value the series is defined against, so these pin both the
 * default and the anchored behaviour.
 */
import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { TimeSeriesChart } from '../TimeSeriesChart'

beforeAll(() => {
    // jsdom has no matchMedia, and the palette hook asks it which mode to draw.
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const BUCKETS = ['2026-06-01', '2026-06-02', '2026-06-03']

/** The axis tick labels, in the order they were drawn. */
function ticks(container: HTMLElement): number[] {
    return [...container.querySelectorAll('text')]
        .map((t) => Number((t.textContent ?? '').replace(/,/g, '')))
        .filter((n) => Number.isFinite(n))
}

/** Every plotted point's y coordinate. */
function pointYs(container: HTMLElement): number[] {
    return [...container.querySelectorAll('polyline')]
        .flatMap((p) => (p.getAttribute('points') ?? '').split(' '))
        .filter(Boolean)
        .map((pair) => Number(pair.split(',')[1]))
}

describe('TimeSeriesChart y-scale', () => {
    it('anchors at zero by default, whatever the data', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={[{ key: 'a', label: 'A', values: [110, 112, 115], slot: 0 }]}
            />,
        )
        expect(Math.min(...ticks(container))).toBe(0)
    })

    it('anchors at the baseline for an indexed series', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={[{ key: 'a', label: 'A', values: [100, 106, 115], slot: 0 }]}
                baseline={100}
            />,
        )
        // The floor is the baseline — a 0..115 axis would squash a 15-point
        // move into the top eighth of the plot and read as "flat".
        expect(Math.min(...ticks(container))).toBe(100)
    })

    it('never clips a series that dips below the baseline', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={[{ key: 'a', label: 'A', values: [100, 88, 104], slot: 0 }]}
                baseline={100}
            />,
        )
        // 88 is below the requested floor, so the floor gives way. A baseline
        // that clipped its own data would be a lie rather than a zoom.
        expect(Math.min(...ticks(container))).toBeLessThanOrEqual(88)

        // Nothing escapes the drawing area in either direction.
        const ys = pointYs(container)
        const height = Number(container.querySelector('svg')!.getAttribute('height'))
        expect(ys.length).toBe(3)
        expect(ys.every((v) => v >= 0 && v <= height)).toBe(true)
    })
})

describe('TimeSeriesChart annotations', () => {
    const SERIES = [{ key: 'a', label: 'A', values: [1, 2, 3], slot: 0 }]

    /** Every annotation rule drawn on the plot — the VERTICAL lines. The
     *  gridlines are horizontal, so x1 === x2 separates them. */
    function rules(container: HTMLElement): Element[] {
        return [...container.querySelectorAll('line')].filter(
            (l) => l.getAttribute('x1') === l.getAttribute('x2'),
        )
    }

    it('draws one rule per moment, not one per finding', () => {
        // A source that stops reporting raises a finding per metric, and a
        // reload moves entities, relationships and a type at the same instant.
        // Eleven marks on one tick stacked eleven identical lines, which only
        // made that tick darker than its neighbours for no reason a reader
        // could name.
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[
                    { bucket: '2026-06-02', title: 'Stopped reporting · severe' },
                    { bucket: '2026-06-02', title: 'Stopped reporting · severe' },
                    { bucket: '2026-06-02', title: 'Node gone · severe' },
                ]}
            />,
        )
        expect(rules(container)).toHaveLength(1)
    })

    it('prints the instant once and counts the repeats', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[
                    ...Array.from({ length: 7 }, () => ({
                        bucket: '2026-06-02', title: 'Stopped reporting · severe',
                    })),
                    { bucket: '2026-06-02', title: 'Node gone · severe' },
                ]}
            />,
        )
        const items = [...container.querySelectorAll('li')]
        // ONE row for the moment, not eight.
        expect(items).toHaveLength(1)
        const text = items[0].textContent ?? ''
        // "seven sources stopped" is a different fact from "one did", and
        // printing the sentence seven times said it less clearly.
        expect(text).toContain('×7')
        expect(text).toContain('Node gone · severe')
        // The timestamp is not repeated per finding.
        expect(text.match(/Jun/g) ?? []).toHaveLength(1)
    })

    it('keeps separate moments separate, in bucket order', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[
                    { bucket: '2026-06-03', title: 'Later' },
                    { bucket: '2026-06-01', title: 'Earlier' },
                ]}
            />,
        )
        const items = [...container.querySelectorAll('li')]
        expect(items).toHaveLength(2)
        expect(items[0].textContent).toContain('Earlier')
        expect(items[1].textContent).toContain('Later')
    })

    it('tints the key by severity while the plot stays chrome', () => {
        // Someone scanning a dozen marks for the one that matters is reading
        // colour, not prose. But the rule on the plot must not compete with
        // the values it is context for — so the tint lives on the key only.
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[
                    { bucket: '2026-06-01', title: 'Lost 2.1M', tone: 'danger' },
                    { bucket: '2026-06-02', title: 'Stopped reporting', tone: 'warn' },
                    { bucket: '2026-06-03', title: 'Rebuilt' },
                ]}
            />,
        )
        const chips = [...container.querySelectorAll('li span[class*="px-1.5"]')]
        const classes = chips.map((c) => c.className)
        expect(classes.some((c) => c.includes('rose'))).toBe(true)
        expect(classes.some((c) => c.includes('amber'))).toBe(true)
        // No tone given falls back to the recessive chip, never to a colour.
        expect(classes.some((c) => c.includes('text-ink-muted'))).toBe(true)
        // ...and every rule on the plot is still the one neutral stroke.
        const strokes = new Set(rules(container).map((l) => l.getAttribute('stroke')))
        expect(strokes.size).toBe(1)
    })

    it('takes the worst tone when one sentence arrives at two weights', () => {
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[
                    { bucket: '2026-06-02', title: 'Stopped reporting', tone: 'warn' },
                    { bucket: '2026-06-02', title: 'Stopped reporting', tone: 'danger' },
                ]}
            />,
        )
        const chip = container.querySelector('li span[class*="px-1.5"]')
        expect(chip?.className).toContain('rose')
        expect(container.querySelector('li')?.textContent).toContain('×2')
    })

    it('ignores an annotation that lands outside the window', () => {
        // The plot and the key must name exactly the same set; an unsnapped
        // annotation in the list with no rule beside it reads as a bug.
        const { container } = render(
            <TimeSeriesChart
                buckets={BUCKETS}
                series={SERIES}
                annotations={[{ bucket: '2025-01-01', title: 'Long ago' }]}
            />,
        )
        expect(container.querySelectorAll('li')).toHaveLength(0)
        expect(rules(container)).toHaveLength(0)
    })
})
