/**
 * The meter has to be honest about three states the naive version gets wrong:
 * a wiped overlay, an overlay that legitimately has no edges, and one that
 * cannot be measured at all.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { OverlayIntegrityMeter } from './OverlayIntegrityMeter'

function bar(container: HTMLElement) {
    return container.querySelector('[role="meter"] > div') as HTMLElement
}

describe('OverlayIntegrityMeter', () => {
    it('shows both magnitudes, not just a percentage', () => {
        render(<OverlayIntegrityMeter observed={0} expected={1204318} />)
        expect(screen.getByText('0')).toBeInTheDocument()
        expect(screen.getByText('/ 1,204,318')).toBeInTheDocument()
    })

    it('a wiped overlay reads as empty and says what was expected', () => {
        const { container } = render(
            <OverlayIntegrityMeter observed={0} expected={500} />,
        )
        expect(bar(container)).toHaveStyle({ width: '0%' })
        expect(screen.getByText(/Expected 500 — none found/)).toBeInTheDocument()
    })

    it('never paints a non-zero value as an empty bar', () => {
        // 1 of 100,000 is 0.001% — a hairline is the honest rendering of
        // "some, but very few"; zero width would say "none", which is wrong.
        const { container } = render(
            <OverlayIntegrityMeter observed={1} expected={100_000} />,
        )
        const width = parseFloat(bar(container).style.width)
        expect(width).toBeGreaterThan(0)
    })

    it('a legitimately empty rollup reads as whole, not as missing', () => {
        // A containment-only graph materialises zero AGGREGATED edges. There
        // is nothing missing, so the meter must not shout.
        const { container } = render(
            <OverlayIntegrityMeter observed={0} expected={0} />,
        )
        expect(bar(container).className).toContain('emerald')
    })

    it('escalates tone as more of the rollup goes missing', () => {
        const full = render(<OverlayIntegrityMeter observed={95} expected={100} />)
        expect(bar(full.container).className).toContain('emerald')
        const part = render(<OverlayIntegrityMeter observed={60} expected={100} />)
        expect(bar(part.container).className).toContain('amber')
        const gone = render(<OverlayIntegrityMeter observed={10} expected={100} />)
        expect(bar(gone.container).className).toContain('red')
    })

    it('explains a dedicated projection instead of showing a false zero', () => {
        // Its rollups live in a graph the statistics scan never reads, so the
        // observed count is meaningless — showing it as 0 would be a lie.
        render(<OverlayIntegrityMeter observed={0} expected={500} unobservable />)
        expect(screen.getByText(/separate graph/i)).toBeInTheDocument()
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    })

    it('says so when the source has never been profiled', () => {
        render(<OverlayIntegrityMeter observed={null} expected={null} />)
        expect(screen.getByText(/not profiled this source/i)).toBeInTheDocument()
    })

    it('carries an accessible value for the bar', () => {
        render(<OverlayIntegrityMeter observed={250} expected={500} />)
        const meter = screen.getByRole('meter')
        expect(meter).toHaveAttribute('aria-valuenow', '250')
        expect(meter).toHaveAttribute('aria-valuemax', '500')
    })
})
