/**
 * The pipeline's phase vocabulary and stepper live in shared.tsx so both
 * Job History and the Freshness cockpit render the SAME phase names. Two
 * hard-coded copies would drift the moment the pipeline gains a phase.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PHASES, PHASE_BANDS, PHASE_LABELS, PhaseStepper, phaseLabel } from './shared'

describe('phase vocabulary', () => {
    it('names every pipeline phase', () => {
        expect(PHASE_LABELS.extracting).toBe('Extracting lineage edges')
        expect(PHASE_LABELS.computing).toBe('Computing rollups')
        expect(PHASE_LABELS.reconciling).toBe('Reconciling existing aggregated edges')
        expect(PHASE_LABELS.applying).toBe('Writing aggregated edges')
    })

    it('falls back to a generic label for an unknown phase', () => {
        expect(phaseLabel('teleporting')).toBe('Processing lineage edges')
        expect(phaseLabel(null)).toBe('Processing lineage edges')
    })

    it('keeps PHASES and PHASE_BANDS aligned with PHASE_LABELS', () => {
        expect(PHASES.map(p => p.id)).toEqual(['extracting', 'computing', 'reconciling', 'applying'])
        for (const p of PHASES) {
            expect(PHASE_LABELS[p.id]).toBeTruthy()
            expect(PHASE_BANDS[p.id]).toHaveLength(2)
        }
    })
})

describe('PhaseStepper', () => {
    it('renders all four segments for a running job', () => {
        render(<PhaseStepper currentPhase="computing" runStats={null} status="running" />)
        for (const label of ['Extract', 'Compute', 'Reconcile', 'Apply']) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
    })

    it('renders per-phase durations once completed', () => {
        render(<PhaseStepper currentPhase={null} runStats={{ extract_s: 62 }} status="completed" />)
        expect(screen.getByText('1m 2s')).toBeInTheDocument()
    })

    it('renders nothing for a job with no phase that has not completed', () => {
        const { container } = render(<PhaseStepper currentPhase={null} runStats={null} status="pending" />)
        expect(container).toBeEmptyDOMElement()
    })
})
