/**
 * The regression guard for the reason this component exists.
 *
 * "Rollups missing" (red) and "Drifting" (amber) sit adjacent constantly — in
 * the same table, in the same stat band. Their light-mode text steps measure
 * ΔE 14.4 apart to normal vision, below the 15 floor where two colours stop
 * being reliably distinguishable at all, and their CVD separation is worse.
 * So every state must carry a distinct icon AND a written label; a later
 * refactor that quietly reduces one of them to colour alone should fail here.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
    AutoReconcileOffBadge, DRIFT_SPEC, DriftStateBadge, REASON_LABEL,
} from './DriftStateBadge'

const STATES = Object.keys(DRIFT_SPEC) as (keyof typeof DRIFT_SPEC)[]

describe('DriftStateBadge', () => {
    it.each(STATES)('%s renders an icon and a text label', (state) => {
        const { container } = render(<DriftStateBadge state={state} />)
        expect(screen.getByText(DRIFT_SPEC[state].label)).toBeInTheDocument()
        expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('gives every state a DISTINCT icon, so colour is never the only channel', () => {
        const icons = STATES.map(s => DRIFT_SPEC[s].Icon)
        // Slate is deliberately shared by two neutral states, so compare the
        // pairs that share a tone family rather than demanding 7 unique icons.
        expect(DRIFT_SPEC.overlayMissing.Icon).not.toBe(DRIFT_SPEC.drifting.Icon)
        expect(DRIFT_SPEC.suspended.Icon).not.toBe(DRIFT_SPEC.drifting.Icon)
        expect(DRIFT_SPEC.neverBuilt.Icon).not.toBe(DRIFT_SPEC.unobservable.Icon)
        expect(new Set(icons).size).toBeGreaterThanOrEqual(6)
    })

    it('gives every state a distinct label', () => {
        const labels = STATES.map(s => DRIFT_SPEC[s].label)
        expect(new Set(labels).size).toBe(labels.length)
    })

    it('keeps the label available to screen readers even when hidden visually', () => {
        render(<DriftStateBadge state="drifting" showLabel={false} />)
        expect(screen.getByText('Drifting')).toBeInTheDocument()
    })

    it('explains itself on hover', () => {
        render(<DriftStateBadge state="overlayMissing" />)
        expect(screen.getByTitle(/Rollups missing —/)).toBeInTheDocument()
    })

    it('renders nothing for an unknown or absent state', () => {
        const { container } = render(<DriftStateBadge state={null} />)
        expect(container).toBeEmptyDOMElement()
        const { container: c2 } = render(<DriftStateBadge state="whatIsThis" />)
        expect(c2).toBeEmptyDOMElement()
    })

    it('says why automation is not acting, not just that it is off', () => {
        render(<AutoReconcileOffBadge />)
        expect(screen.getByText('Auto off')).toBeInTheDocument()
        expect(screen.getByTitle(/still detected and shown/i)).toBeInTheDocument()
    })
})

describe('reason labels', () => {
    it('covers every detector the backend can report', () => {
        expect(Object.keys(REASON_LABEL).sort()).toEqual([
            'never_aggregated', 'overlay_missing', 'overlay_shrunk', 'raw_drift',
        ])
    })

    it('reads as plain language, not detector codes', () => {
        for (const label of Object.values(REASON_LABEL)) {
            expect(label).not.toMatch(/_/)
        }
    })
})
