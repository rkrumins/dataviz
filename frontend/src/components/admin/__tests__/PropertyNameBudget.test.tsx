/**
 * PropertyNameBudget — the attribute-name ceiling, drawn as a meter.
 *
 * The contract that matters most here is that a MISSING reading and a reading
 * of ZERO are opposite situations. `null` means the store would not answer;
 * 0 would mean the graph genuinely has no properties. This figure exists to
 * warn about graphs filling a one-way budget, so rendering "not measured" as
 * 0% would say "plenty of room" about precisely the graphs we cannot see.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
    PropertyNameBudget,
    PROPERTY_NAME_CEILING,
    propertyNameBand,
} from '../PropertyNameBudget'

describe('PropertyNameBudget', () => {
    it('says so when the reading is missing, rather than drawing an empty budget', () => {
        render(<PropertyNameBudget total={null} />)
        expect(screen.getByText(/not measured yet/i)).toBeInTheDocument()
        // No meter at all — an unknown value has no position on a scale.
        expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    })

    it('renders a real zero as a measured zero, not as "unknown"', () => {
        render(<PropertyNameBudget total={0} />)
        expect(screen.queryByText(/not measured/i)).not.toBeInTheDocument()
        expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0')
    })

    it('exposes the ceiling to assistive tech, not just to the eye', () => {
        render(<PropertyNameBudget total={41_203} />)
        const meter = screen.getByRole('meter')
        expect(meter).toHaveAttribute('aria-valuenow', '41203')
        expect(meter).toHaveAttribute('aria-valuemax', String(PROPERTY_NAME_CEILING))
    })

    it('names the state in text, never by colour alone', () => {
        render(<PropertyNameBudget total={64_000} />)
        // Colour-blind, greyscale and forced-colors readers all get this.
        expect(screen.getByText('Near the limit')).toBeInTheDocument()
        expect(screen.getByText(/never freed/i)).toBeInTheDocument()
    })

    it('direct-labels both parts of the split so identity is not colour-coded', () => {
        render(<PropertyNameBudget total={41_203} platform={38} source={41_165} />)
        expect(screen.getByText(/38 platform/)).toBeInTheDocument()
        expect(screen.getByText(/41,165 from this source/)).toBeInTheDocument()
    })

    it('draws no split when only the total is known', () => {
        render(<PropertyNameBudget total={41_203} />)
        expect(screen.queryByText(/platform/i)).not.toBeInTheDocument()
    })

    it('hides the label and legend in the compact variant but keeps the meter', () => {
        render(<PropertyNameBudget total={41_203} platform={38} source={41_165} compact />)
        expect(screen.queryByText('Property names')).not.toBeInTheDocument()
        expect(screen.queryByText(/38 platform/)).not.toBeInTheDocument()
        expect(screen.getByRole('meter')).toBeInTheDocument()
    })
})

describe('propertyNameBand', () => {
    it('escalates on the share of the ceiling, not on a raw count', () => {
        expect(propertyNameBand(0).key).toBe('healthy')
        expect(propertyNameBand(45_000).key).toBe('healthy')        // 68.7%
        expect(propertyNameBand(46_000).key).toBe('filling')        // 70.2%
        expect(propertyNameBand(58_000).key).toBe('filling')        // 88.5%
        expect(propertyNameBand(59_000).key).toBe('near')           // 90.0%
        expect(propertyNameBand(PROPERTY_NAME_CEILING).key).toBe('near')
    })

    it('is exact at the band edges', () => {
        expect(propertyNameBand(Math.ceil(PROPERTY_NAME_CEILING * 0.7)).key).toBe('filling')
        expect(propertyNameBand(Math.ceil(PROPERTY_NAME_CEILING * 0.9)).key).toBe('near')
    })
})
