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

// ── the run's own step ledger ────────────────────────────────────────
//
// Four segments derived from ``currentPhase`` is all a run without a ledger
// can offer: the phase names the pipeline emits are the only four it knows,
// and the durations under them only exist once the run is over. A run WITH a
// ledger keeps the same stepper and fills it in — every stage of the run
// including the two the pipeline never names, each one's progress within
// itself, and the durations live rather than at the end.

const _step = (over: Record<string, unknown> & { id: string }) => ({
    state: 'pending', started_at: null, ended_at: null, secs: 0, visits: 0,
    done: null, total: null, unit: null, waiting_for: null, ...over,
}) as never

describe('PhaseStepper over a step ledger', () => {
    const ledger = [
        _step({ id: 'preparing', state: 'done', secs: 12 }),
        _step({ id: 'extracting', state: 'done', secs: 200, done: 500_000, total: 500_000, unit: 'lineage edges' }),
        _step({ id: 'computing', state: 'done', secs: 18 }),
        _step({
            id: 'reconciling', state: 'running', secs: 0,
            started_at: new Date().toISOString(), done: 3, total: 12, unit: 'scan ranges',
        }),
        _step({ id: 'applying' }),
        _step({ id: 'finalizing' }),
    ]

    it('keeps the stepper and shows every stage of the run', () => {
        render(<PhaseStepper currentPhase="reconciling" runStats={{ steps: ledger }} status="running" />)
        for (const label of ['Prepare', 'Extract', 'Compute', 'Reconcile', 'Apply', 'Finish']) {
            expect(screen.getByText(label)).toBeInTheDocument()
        }
    })

    it('says what the stage it is on means and how far through it is', () => {
        render(<PhaseStepper currentPhase="reconciling" runStats={{ steps: ledger }} status="running" />)
        const now = screen.getByTestId('step-now')
        expect(now.textContent).toContain('aggregated edge already stored')
        expect(now.textContent).toContain('3 of 12 scan ranges')
        expect(now.textContent).toContain('9 left')
    })

    it('shows the finished stages’ durations while the run is still going', () => {
        // The four-segment fallback can only show these once the run is over:
        // the pipeline reports per-phase timings in its final result.
        render(<PhaseStepper currentPhase="reconciling" runStats={{ steps: ledger }} status="running" />)
        expect(screen.getByText('12s')).toBeInTheDocument()
        expect(screen.getByText('3m 20s')).toBeInTheDocument()
    })

    it('names the stage a failed run died in', () => {
        const died = [
            _step({ id: 'preparing', state: 'done', secs: 12 }),
            _step({ id: 'extracting', state: 'failed', secs: 44, done: 120, total: 900, unit: 'lineage edges' }),
            _step({ id: 'computing' }),
        ]
        render(<PhaseStepper currentPhase={null} runStats={{ steps: died }} status="failed" />)
        expect(screen.getByText('Extract').className).toContain('text-red-400')
        expect(screen.queryByTestId('step-now')).toBeNull()
    })

    it('says a parked stage is waiting, and what for', () => {
        const parked = [
            _step({
                id: 'extracting', state: 'waiting', secs: 30,
                started_at: new Date().toISOString(), waiting_for: 'retry 1/3',
            }),
        ]
        render(<PhaseStepper currentPhase="extracting" runStats={{ steps: parked }} status="running" />)
        expect(screen.getByTestId('step-now').textContent).toContain('waiting — retry 1/3')
    })
})


// ── this run against the last one ────────────────────────────────────────

describe('PhaseStepper against a previous run', () => {
    const ledger = (over: Record<string, unknown>[] = []) => [
        _step({ id: 'preparing', state: 'done', secs: 12 }),
        _step({ id: 'extracting', state: 'done', secs: 100 }),
        _step({ id: 'computing', state: 'done', secs: 10 }),
        _step({ id: 'reconciling', state: 'done', secs: 40 }),
        _step({ id: 'applying', state: 'done', secs: 600 }),
        _step({ id: 'finalizing', state: 'done', secs: 8 }),
        ...(over as never[]),
    ]
    const previous = {
        steps: [
            _step({ id: 'preparing', state: 'done', secs: 12 }),
            _step({ id: 'extracting', state: 'done', secs: 100 }),
            _step({ id: 'computing', state: 'done', secs: 10 }),
            _step({ id: 'reconciling', state: 'done', secs: 40 }),
            _step({ id: 'applying', state: 'done', secs: 200 }),
            _step({ id: 'finalizing', state: 'done', secs: 8 }),
        ],
    }

    it('marks the stage that got materially slower', () => {
        render(
            <PhaseStepper
                currentPhase={null} status="completed"
                runStats={{ steps: ledger() }} previousRunStats={previous}
            />,
        )
        expect(screen.getByText('↑200%')).toBeInTheDocument()
        // …and says nothing about the five stages that did not move.
        expect(screen.queryByText('↑0%')).toBeNull()
    })

    it('says nothing at all without a previous run to compare against', () => {
        render(
            <PhaseStepper
                currentPhase={null} status="completed" runStats={{ steps: ledger() }}
            />,
        )
        expect(screen.queryByText(/↑|↓/)).toBeNull()
    })

    it('warns when the running stage is well past its own last time', () => {
        const running = [
            _step({ id: 'extracting', state: 'done', secs: 100 }),
            _step({
                id: 'applying', state: 'running', secs: 0,
                started_at: new Date(Date.now() - 520_000).toISOString(),
            }),
        ]
        render(
            <PhaseStepper
                currentPhase="applying" status="running"
                runStats={{ steps: running }} previousRunStats={previous}
            />,
        )
        const slip = screen.getByTestId('stage-slip')
        expect(slip.textContent).toContain('Apply has been running')
        expect(slip.textContent).toContain('last run\u2019s took 3m 20s')
        expect(slip.textContent).toContain('2.6× longer')
    })

    it('stays quiet while the running stage is merely running', () => {
        const running = [
            _step({
                id: 'applying', state: 'running', secs: 0,
                started_at: new Date(Date.now() - 180_000).toISOString(),
            }),
        ]
        render(
            <PhaseStepper
                currentPhase="applying" status="running"
                runStats={{ steps: running }} previousRunStats={previous}
            />,
        )
        expect(screen.queryByTestId('stage-slip')).toBeNull()
    })
})
