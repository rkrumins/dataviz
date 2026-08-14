/**
 * The reason Callout exists as a primitive rather than another hand-rolled
 * div: it holds the accessibility contract in one place. Severity must reach
 * a reader who cannot see the colour — via an icon and a text label — because
 * on a light surface the warning and serious tones sit below 3:1 by design.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Callout, type CalloutTone } from './Callout'

const TONES: CalloutTone[] = ['info', 'warning', 'serious', 'critical']

describe('Callout', () => {
    it.each(TONES)('names the %s tone in text, not just colour', tone => {
        const { container } = render(<Callout tone={tone}>Body copy</Callout>)

        // A screen-reader-only tone label, so severity survives with no colour.
        expect(container.querySelector('.sr-only')?.textContent).toMatch(/\w+: /)
        // ...and an icon alongside it, for greyscale print and forced-colours.
        expect(container.querySelector('svg')).toBeTruthy()
    })

    it('gives each tone a distinct icon, so tones differ without colour', () => {
        const paths = TONES.map(tone => {
            const { container } = render(<Callout tone={tone}>x</Callout>)
            return container.querySelector('svg')?.innerHTML ?? ''
        })
        expect(new Set(paths).size).toBe(TONES.length)
    })

    it('renders body content and an optional title', () => {
        render(<Callout tone="warning" title="Approaching the budget">Only 12% left.</Callout>)

        expect(screen.getByText('Approaching the budget')).toBeTruthy()
        expect(screen.getByText('Only 12% left.')).toBeTruthy()
    })

    it('renders footer content for an embedded meter or actions', () => {
        render(
            <Callout tone="critical" footer={<span data-testid="meter">meter</span>}>
                Over budget.
            </Callout>,
        )
        expect(screen.getByTestId('meter')).toBeTruthy()
    })

    it('is exposed as a note, so it is reachable rather than decorative', () => {
        render(<Callout>Heads up</Callout>)
        expect(screen.getByRole('note')).toBeTruthy()
    })

    it('defaults to the info tone', () => {
        const { container } = render(<Callout>Neutral</Callout>)
        expect(container.querySelector('.sr-only')?.textContent).toBe('Information: ')
    })
})
