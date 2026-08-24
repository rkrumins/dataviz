/**
 * Small multiples — the properties that make them multiples rather than a
 * grid of unrelated sparklines.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ProfilingSeries } from '@/types/profiling'
import { TypeTrellis } from '../TypeTrellis'

const BUCKETS = ['2026-08-21', '2026-08-22', '2026-08-23']

function series(key: string, values: number[]): ProfilingSeries {
    return {
        key, label: key, kind: 'type',
        points: values.map((v, i) => ({ t: BUCKETS[i], v })),
    }
}

function polyline(name: RegExp): SVGPolylineElement {
    const svg = screen.getByRole('img', { name })
    const line = svg.querySelector('polyline')
    if (!line) throw new Error('no polyline drawn')
    return line as SVGPolylineElement
}

/** The y of the last point, as drawn. */
function lastY(line: SVGPolylineElement): number {
    const points = (line.getAttribute('points') ?? '').trim().split(/\s+/)
    return Number(points[points.length - 1].split(',')[1])
}

describe('TypeTrellis', () => {
    it('draws every panel on ONE scale by default', () => {
        // The failure this exists to prevent: per-panel maxima make a type
        // that moved by 3 look exactly as dramatic as one that moved by
        // 30,000, which is the opposite of what a trellis is for.
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[series('big', [0, 500, 1000]), series('small', [0, 5, 10])]}
            />,
        )
        const big = lastY(polyline(/^big:/))
        const small = lastY(polyline(/^small:/))
        // Lower y = higher on the plot. On a shared scale the 1,000 series
        // must sit far above the 10 series.
        expect(big).toBeLessThan(small)
    })

    it('says so when the shared scale is on', () => {
        render(
            <TypeTrellis buckets={BUCKETS} series={[series('a', [1, 2, 3])]} />,
        )
        expect(screen.getByText(/one shared scale/i)).toBeInTheDocument()
    })

    it('lets a reader fit each panel, and names what that costs', async () => {
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[series('big', [0, 500, 1000]), series('small', [0, 5, 10])]}
            />,
        )
        // Named for the cost, not the benefit: "fit each" sounds like an
        // improvement, and the axes stop matching.
        await userEvent.click(screen.getByLabelText(/axes differ/i))

        const big = lastY(polyline(/^big:/))
        const small = lastY(polyline(/^small:/))
        expect(big).toBeCloseTo(small, 1)
    })

    it('puts a vanished type first whatever its size', () => {
        // A type reaching zero is the finding, and as a share of a large graph
        // it rarely ranks near the top by magnitude.
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[
                    series('huge', [0, 5_000, 9_000]),
                    series('vanished', [40, 20, 0]),
                ]}
            />,
        )
        const panels = screen.getAllByRole('img')
        expect(panels[0]).toHaveAccessibleName(/^vanished:/)
        expect(screen.getByText('gone')).toBeInTheDocument()
    })

    it('offers a way into one type', async () => {
        const onFocus = vi.fn()
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[series('object', [1, 2, 3])]}
                onFocus={onFocus}
            />,
        )
        await userEvent.click(screen.getByRole('button', { name: /object/i }))
        expect(onFocus).toHaveBeenCalledWith('object')
    })

    it('draws nothing from a single observation', () => {
        // One point is not a trend, and a panel implying one is a lie about
        // data that does not exist yet.
        const { container } = render(
            <TypeTrellis buckets={['2026-08-23']} series={[series('a', [5])]} />,
        )
        expect(container).toBeEmptyDOMElement()
    })
})

describe('TypeTrellis — reaching the count', () => {
    it('answers a hover with the value at that bucket', async () => {
        // Without a hover a panel can only say where the series started and
        // ended; the count AT a bucket was unreachable, which made the trellis
        // the one over-time surface that would not tell you a value.
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[series('object', [10, 250, 30])]}
            />,
        )
        // At rest the footer frames the window.
        expect(screen.getByText('+20')).toBeInTheDocument()

        const hits = screen.getByRole('img', { name: /^object:/ }).querySelectorAll('rect')
        fireEvent.mouseEnter(hits[1])
        expect(await screen.findByText('250')).toBeInTheDocument()
    })

    it('returns to the window summary when the pointer leaves', async () => {
        render(
            <TypeTrellis
                buckets={BUCKETS}
                series={[series('object', [10, 250, 30])]}
            />,
        )
        const svg = screen.getByRole('img', { name: /^object:/ })
        fireEvent.mouseEnter(svg.querySelectorAll('rect')[1])
        expect(await screen.findByText('250')).toBeInTheDocument()

        fireEvent.mouseLeave(svg)
        expect(screen.queryByText('250')).not.toBeInTheDocument()
        expect(screen.getByText('+20')).toBeInTheDocument()
    })
})
