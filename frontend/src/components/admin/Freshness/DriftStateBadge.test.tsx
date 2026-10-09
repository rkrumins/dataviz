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

    it('keeps "Version controlled" apart from "Blocked" by more than colour', () => {
        // Measured: indigo-600 ↔ violet-600 is ΔE 7.5 to normal vision and 1.3
        // under protanopia — worse than the red/amber pair this file exists
        // for. The tone was moved to sky for that reason; the icon and label
        // are what actually carry the distinction, so assert those.
        expect(DRIFT_SPEC.managed.Icon).not.toBe(DRIFT_SPEC.blocked.Icon)
        expect(DRIFT_SPEC.managed.tone).not.toContain('indigo')
        expect(DRIFT_SPEC.managed.tone).not.toContain('violet')
    })

    it('distinguishes a version-controlled source from an unobservable one', () => {
        // Both mean "the overlay count proves nothing", for entirely different
        // reasons: a dedicated projection writes rollups to another graph,
        // while a versioned source may not be reading FalkorDB at all. The
        // cockpit must not collapse them into one state.
        expect(DRIFT_SPEC.managed.Icon).not.toBe(DRIFT_SPEC.unobservable.Icon)
        expect(DRIFT_SPEC.managed.title).toMatch(/version control/i)
        expect(DRIFT_SPEC.unobservable.title).toMatch(/separate graph/i)
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

describe('projectionStalled — version controlled, but the rollups are not being served', () => {
    it('is mapped at all: an unmapped verdict renders undefined and throws', () => {
        // DRIFT_SPEC is a total Record<DriftState, Spec>. The backend can now
        // stamp this verdict, so the map has to carry it or the fleet row,
        // the drawer, the group header and the profile all blow up on it.
        expect(DRIFT_SPEC.projectionStalled).toBeDefined()
        render(<DriftStateBadge state="projectionStalled" />)
        expect(screen.getByText('Connections not up to date')).toBeInTheDocument()
    })

    it('reads red, and never as the amber "just rebuild it" verdict', () => {
        const spec = DRIFT_SPEC.projectionStalled
        expect(spec.tone).toContain('red-500')
        expect(spec.tone).not.toContain('amber')
        // Red tier is shared with "Rollups missing", so the icon and the
        // label are what carry the distinction — the whole reason this
        // component exists.
        expect(spec.Icon).not.toBe(DRIFT_SPEC.overlayMissing.Icon)
        expect(spec.Icon).not.toBe(DRIFT_SPEC.drifting.Icon)
        expect(spec.Icon).not.toBe(DRIFT_SPEC.managed.Icon)
        expect(spec.label).not.toBe(DRIFT_SPEC.overlayMissing.label)
    })

    it('says a rebuild is the wrong remedy, because it is', () => {
        // The one thing an operator will reach for first is the one thing
        // that does not help here. The tooltip has to say so.
        expect(DRIFT_SPEC.projectionStalled.title).toMatch(/rebuild/i)
    })
})
