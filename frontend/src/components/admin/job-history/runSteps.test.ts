import { describe, it, expect } from 'vitest'
import type { RunStep } from '@/services/aggregationService'
import {
    describeStep, describeSteps, currentStepSentence, remainingSecsFromLedger, jobStage,
} from './runSteps'

const T0 = Date.parse('2026-09-12T00:00:00.000Z')

const step = (over: Partial<RunStep> & { id: string }): RunStep => ({
    state: 'pending', started_at: null, ended_at: null, secs: 0, visits: 0,
    done: null, total: null, unit: null, waiting_for: null, ...over,
})

describe('describeStep', () => {
    it('ticks the open step forward from when it was entered', () => {
        // The ledger deliberately does not bake the open step's elapsed time
        // into the record — it stores when the step started.
        const v = describeStep(
            step({ id: 'extracting', state: 'running', started_at: '2026-09-12T00:00:00.000Z', secs: 0 }),
            T0 + 42_000,
        )
        expect(v.elapsedS).toBe(42)
        expect(v.open).toBe(true)
    })

    it('adds the live time to what earlier visits already accumulated', () => {
        const v = describeStep(
            step({ id: 'extracting', state: 'running', started_at: '2026-09-12T00:00:00.000Z', secs: 30, visits: 2 }),
            T0 + 10_000,
        )
        expect(v.elapsedS).toBe(40)
        expect(v.visits).toBe(2)
    })

    it('says what is left, in the stage’s own units', () => {
        const v = describeStep(
            step({
                id: 'applying', state: 'running', started_at: '2026-09-12T00:00:00.000Z',
                done: 182_400, total: 500_000, unit: 'aggregated edges',
            }),
            T0,
        )
        expect(v.detail).toBe('182,400 of 500,000 aggregated edges · 317,600 left')
        expect(v.pct).toBe(36)
    })

    it('reports a finished stage as what it got through, not what is left', () => {
        const v = describeStep(
            step({ id: 'extracting', state: 'done', secs: 200, done: 500_000, total: 500_000, unit: 'lineage edges' }),
            T0,
        )
        expect(v.detail).toBe('500,000 lineage edges')
        expect(v.elapsedS).toBe(200)
        expect(v.open).toBe(false)
    })

    it('a parked stage says what it is waiting for instead of its counters', () => {
        const v = describeStep(
            step({
                id: 'extracting', state: 'waiting', started_at: '2026-09-12T00:00:00.000Z',
                waiting_for: 'retry 1/3', done: 10, total: 100,
            }),
            T0,
        )
        expect(v.detail).toBe('waiting — retry 1/3')
        expect(v.open).toBe(true)
    })

    it('a stage with no countable unit says nothing rather than zero', () => {
        const v = describeStep(step({ id: 'computing', state: 'running', started_at: '2026-09-12T00:00:00.000Z' }), T0)
        expect(v.detail).toBeNull()
        expect(v.pct).toBeNull()
    })

    it('a stage never entered has no elapsed time at all', () => {
        expect(describeStep(step({ id: 'applying' }), T0).elapsedS).toBeNull()
    })

    it('carries a label and an explanation for every stage of the run', () => {
        for (const id of ['preparing', 'extracting', 'computing', 'reconciling', 'applying', 'finalizing']) {
            const v = describeStep(step({ id }), T0)
            expect(v.label).not.toBe(id)
            expect(v.detailLabel.length).toBeGreaterThan(10)
        }
    })
})

describe('currentStepSentence', () => {
    it('numbers the stage the run is on out of all of them', () => {
        const views = describeSteps([
            step({ id: 'preparing', state: 'done', secs: 12 }),
            step({ id: 'extracting', state: 'done', secs: 200 }),
            step({
                id: 'computing', state: 'running', started_at: '2026-09-12T00:00:00.000Z',
            }),
            step({ id: 'applying' }),
        ], T0)
        expect(currentStepSentence(views)).toBe('Step 3 of 4: Compute')
    })

    it('a finished run has no right-now', () => {
        const views = describeSteps([step({ id: 'applying', state: 'done', secs: 5 })], T0)
        expect(currentStepSentence(views)).toBeNull()
    })
})

describe('remainingSecsFromLedger', () => {
    const previous: RunStep[] = [
        step({ id: 'preparing', state: 'done', secs: 20 }),
        step({ id: 'extracting', state: 'done', secs: 100 }),
        step({ id: 'computing', state: 'done', secs: 40 }),
        step({ id: 'reconciling', state: 'done', secs: 60 }),
        step({ id: 'applying', state: 'done', secs: 200 }),
        step({ id: 'finalizing', state: 'done', secs: 30 }),
    ]

    const runningAt = (id: string, over: Partial<RunStep> = {}): RunStep[] =>
        previous.map(p => p.id === id
            ? step({ ...p, state: 'running', secs: 0, started_at: '2026-09-12T00:00:00.000Z', ...over })
            : step({ id: p.id, state: previous.findIndex(x => x.id === p.id) < previous.findIndex(x => x.id === id) ? 'done' : 'pending' }))

    it('owes the rest of this stage plus every stage after it', () => {
        // Half through reconcile: 30 left of it, then apply (200) + finish (30).
        const secs = remainingSecsFromLedger(
            runningAt('reconciling', { done: 5, total: 10 }), previous, T0,
        )
        expect(secs).toBe(30 + 200 + 30)
    })

    it('counts the two stages the four-phase projection could never see', () => {
        // Sitting in PREPARE, which the old estimate had no term for at all.
        const secs = remainingSecsFromLedger(runningAt('preparing'), previous, T0)
        expect(secs).toBe(20 + 100 + 40 + 60 + 200 + 30)
    })

    it('uses this run’s own rate once it is slower than last time', () => {
        // A tenth of the way through apply after 300s: this run's rate says
        // 2,700s to go, which beats history's 180s.
        const secs = remainingSecsFromLedger(
            runningAt('applying', { done: 100, total: 1_000 }), previous, T0 + 300_000,
        )
        expect(secs).toBe(2_700 + 30)
    })

    it('declines when either run has no ledger', () => {
        expect(remainingSecsFromLedger(undefined, previous, T0)).toBeNull()
        expect(remainingSecsFromLedger(runningAt('applying'), [], T0)).toBeNull()
    })

    it('declines when the previous run was too fast to be signal', () => {
        const trivial = previous.map(p => step({ id: p.id, state: 'done', secs: 0.2 }))
        expect(remainingSecsFromLedger(runningAt('applying'), trivial, T0)).toBeNull()
    })

    it('declines when nothing is open', () => {
        expect(remainingSecsFromLedger(previous, previous, T0)).toBeNull()
    })
})


describe('jobStage', () => {
    it('names the stage and where it sits in the flow', () => {
        const steps = [
            step({ id: 'preparing', state: 'done', secs: 12 }),
            step({ id: 'extracting', state: 'done', secs: 200 }),
            step({ id: 'computing', state: 'done', secs: 10 }),
            step({
                id: 'reconciling', state: 'running', started_at: '2026-09-12T00:00:00.000Z',
                done: 3, total: 12, unit: 'scan ranges',
            }),
            step({ id: 'applying' }),
            step({ id: 'finalizing' }),
        ]
        expect(jobStage(steps, 'reconciling', T0)).toEqual({
            label: 'Reconcile',
            detail: '3 of 12 scan ranges · 9 left',
            position: '4/6',
        })
    })

    it('falls back to the pipeline phase for a run with no ledger', () => {
        expect(jobStage(undefined, 'applying', T0)).toEqual({
            label: 'Apply', detail: null, position: null,
        })
    })

    it('never goes blank — a running job with nothing to go on is Working', () => {
        // A blank here reads as a job doing nothing, which is the opposite of
        // what a running row means.
        expect(jobStage(undefined, null, T0).label).toBe('Working')
        expect(jobStage([], undefined, T0).label).toBe('Working')
    })

    it('says nothing about progress once every stage is closed', () => {
        const finished = [step({ id: 'applying', state: 'done', secs: 5 })]
        expect(jobStage(finished, 'applying', T0).position).toBeNull()
    })
})
