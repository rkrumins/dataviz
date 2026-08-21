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
