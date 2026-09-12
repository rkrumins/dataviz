/**
 * The run's step ledger, as the operator reads it.
 *
 * A run used to report one pair of counters and one percentage, and both
 * only ever meant "lineage edges scanned during EXTRACT" — so past the
 * halfway mark the bar moved with its denominator nowhere on the page, and
 * the minutes at each end of the run (indexes and identity stamping before
 * the first phase; the after-fingerprint and the state rows after the last)
 * had no phase at all. The backend now keeps an ordered ledger of the six
 * real steps with each step's OWN unit of work. This turns it into the
 * three things an operator asks: which step, what is done, what is left.
 */
import type { RunStep } from '../../../services/aggregationService'

export const STEP_LABELS: Record<string, string> = {
    preparing: 'Prepare',
    extracting: 'Extract',
    computing: 'Compute',
    reconciling: 'Reconcile',
    applying: 'Apply',
    finalizing: 'Finish',
}

/** What the step actually does — the tooltip, not the label. */
export const STEP_DETAIL: Record<string, string> = {
    preparing: 'Creating the indexes, stamping node identity, and fingerprinting the graph before the run',
    extracting: 'Reading the source graph’s lineage edges',
    computing: 'Rolling that lineage up the containment hierarchy',
    reconciling: 'Comparing every aggregated edge already stored against what this run computed',
    applying: 'Writing the aggregated edges that are missing',
    finalizing: 'Fingerprinting the graph again and recording the result against the data source',
}

export interface StepView {
    id: string
    label: string
    detailLabel: string
    state: string
    /** Open = this step holds the run right now (running or parked). */
    open: boolean
    /** Seconds so far, live for the open step. Null when never entered. */
    elapsedS: number | null
    /** 0-100 across this step's own unit of work; null when it has none. */
    pct: number | null
    /** The right-hand line: what it got through, or what it is waiting for. */
    detail: string | null
    visits: number
}

const _fmt = (n: number) => n.toLocaleString()

/**
 * One step, read as of `nowMs`.
 *
 * The ledger deliberately does NOT bake the open step's elapsed time into
 * the record (that would mark it dirty on every checkpoint and collapse the
 * commit cadence into one write per batch), so the elapsed time for the
 * open step is `secs` plus the time since it was entered.
 */
export function describeStep(step: RunStep, nowMs: number): StepView {
    const open = step.state === 'running' || step.state === 'waiting'
    const started = step.started_at ? Date.parse(step.started_at) : NaN
    const live = open && isFinite(started) ? Math.max(0, (nowMs - started) / 1000) : 0
    const entered = step.state !== 'pending'
    const total = typeof step.total === 'number' && step.total > 0 ? step.total : null
    const done = typeof step.done === 'number' ? step.done : null

    let detail: string | null = null
    if (step.state === 'waiting' && step.waiting_for) {
        detail = `waiting — ${step.waiting_for}`
    } else if (done != null && total != null) {
        detail = open
            ? `${_fmt(done)} of ${_fmt(total)} ${step.unit ?? ''}`.trim() +
              (total > done ? ` · ${_fmt(total - done)} left` : '')
            : `${_fmt(done)} ${step.unit ?? ''}`.trim()
    } else if (done != null) {
        detail = `${_fmt(done)} ${step.unit ?? ''}`.trim()
    }

    return {
        id: step.id,
        label: STEP_LABELS[step.id] ?? step.id,
        detailLabel: STEP_DETAIL[step.id] ?? '',
        state: step.state,
        open,
        elapsedS: entered ? (step.secs ?? 0) + live : null,
        pct: total != null && done != null
            ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
            : null,
        detail,
        visits: step.visits ?? 0,
    }
}

export function describeSteps(
    steps: RunStep[] | undefined | null, nowMs: number,
): StepView[] {
    if (!Array.isArray(steps) || steps.length === 0) return []
    return steps.map(s => describeStep(s, nowMs))
}

/**
 * One line for the collapsed row: the step the run is on, and how far into
 * it. Null when nothing is open — a finished run has no "right now".
 */
export function currentStepSentence(views: StepView[]): string | null {
    const open = views.find(v => v.open)
    if (!open) return null
    const head = `Step ${views.indexOf(open) + 1} of ${views.length}: ${open.label}`
    return open.detail ? `${head} — ${open.detail}` : head
}


/**
 * How many seconds the run still owes, read off its step ledger against the
 * previous run's.
 *
 * The band-based projection it supersedes could only see the pipeline's four
 * phases, and took the "fraction of the current phase" from the overall
 * percentage — which is itself derived from the band, so on a stage whose
 * band is wide it was little more than a restatement. The ledger carries
 * each stage's real unit of work AND the two stages either side of the
 * pipeline, which on a large graph are minutes the old estimate simply
 * omitted.
 *
 * Returns null when either run has no ledger, when nothing is open, or when
 * the previous run is too fast to be signal — the caller falls back.
 */
export function remainingSecsFromLedger(
    current: RunStep[] | undefined | null,
    previous: RunStep[] | undefined | null,
    nowMs: number,
): number | null {
    if (!current?.length || !previous?.length) return null
    const prev = new Map(previous.map(s => [s.id, typeof s.secs === 'number' ? s.secs : 0]))
    let prevTotal = 0
    prev.forEach(v => { prevTotal += v })
    if (prevTotal < 5) return null

    const idx = current.findIndex(s => s.state === 'running' || s.state === 'waiting')
    if (idx < 0) return null
    const open = current[idx]
    const view = describeStep(open, nowMs)
    const frac = view.pct != null ? view.pct / 100 : 0
    // What this stage still owes: what it took last time less the part
    // already through, or — when this run is running slower than that — what
    // this run's OWN rate says. An estimate that keeps sliding is worse than
    // one that was pessimistic from the start.
    const byHistory = (prev.get(open.id) ?? 0) * (1 - frac)
    const byRate = frac > 0 ? (view.elapsedS ?? 0) * (1 / frac - 1) : 0
    let remaining = Math.max(byHistory, byRate)
    for (const later of current.slice(idx + 1)) remaining += prev.get(later.id) ?? 0
    return isFinite(remaining) && remaining > 0 ? remaining : null
}


/**
 * The one line every surface uses to say what a running job is doing:
 * the stage, where it sits in the flow, and that stage's own progress.
 *
 * Deliberately NOT `processedEdges / totalEdges` — those are the EXTRACT
 * counters and stop moving once the extract scan ends, so a job three
 * quarters of the way through APPLY reported "500,000 / 500,000 edges
 * processed" and looked finished.
 */
export function jobStage(
    steps: RunStep[] | undefined | null,
    currentPhase: string | null | undefined,
): { label: string; detail: string | null; position: string | null } {
    // No clock: none of the three fields this returns depends on one — the
    // stage's own counters and its place in the flow are as of the last
    // checkpoint. Taking `Date.now()` here would make every caller impure
    // during render for a value nothing reads.
    const views = describeSteps(steps, 0)
    const open = views.find(v => v.open)
    if (open) {
        return {
            label: open.label,
            detail: open.detail,
            position: `${views.indexOf(open) + 1}/${views.length}`,
        }
    }
    return {
        // A run with no ledger (or one that has not opened its first stage)
        // still has the pipeline's phase, and failing that it is working —
        // never a blank, which reads as a job doing nothing.
        label: STEP_LABELS[currentPhase ?? ''] ?? 'Working',
        detail: null,
        position: null,
    }
}


// ── this run against the last one ────────────────────────────────────────
//
// Per-stage durations only answer "how long did this take". The question an
// operator actually has is "is this getting worse", and both runs carry the
// same ledger, so the comparison is free.

/** A stage change is worth colouring only when it is big in BOTH senses —
 *  a stage that went from 1s to 2s doubled and means nothing. */
const _MATERIAL_PCT = 25
const _MATERIAL_SECS = 5

export interface StageDelta {
    id: string
    label: string
    secs: number
    /** The same stage in the previous run; null when it did not run it. */
    prevSecs: number | null
    /** Percent change against the previous run, null when incomparable. */
    deltaPct: number | null
    /** Big enough in both percent and seconds to be worth saying. */
    material: boolean
}

export function compareStages(
    current: RunStep[] | undefined | null,
    previous: RunStep[] | undefined | null,
): StageDelta[] {
    if (!Array.isArray(current) || current.length === 0) return []
    const prev = new Map(
        (Array.isArray(previous) ? previous : [])
            .filter(s => s.state !== 'pending')
            .map(s => [s.id, typeof s.secs === 'number' ? s.secs : 0]),
    )
    return current
        .filter(s => s.state !== 'pending')
        .map(s => {
            const secs = typeof s.secs === 'number' ? s.secs : 0
            const prevSecs = prev.has(s.id) ? prev.get(s.id)! : null
            const deltaPct = prevSecs && prevSecs > 0
                ? Math.round(((secs - prevSecs) / prevSecs) * 100)
                : null
            return {
                id: s.id,
                label: STEP_LABELS[s.id] ?? s.id,
                secs,
                prevSecs,
                deltaPct,
                material: deltaPct != null
                    && Math.abs(deltaPct) >= _MATERIAL_PCT
                    && Math.abs(secs - (prevSecs ?? 0)) >= _MATERIAL_SECS,
            }
        })
}

// ── is this one stuck, or just slow? ─────────────────────────────────────
//
// The question during an incident, and the one a percentage cannot answer.
// A stage well past what the same stage took last time is the signal; a
// stage merely running is not, so this says nothing until it is.

/** Below these the stage is just running, and saying so is noise. */
const _SLIP_RATIO = 1.5
const _SLIP_SECS = 30

export interface StageSlip {
    label: string
    elapsedS: number
    expectedS: number
    /** How many times longer than last time, e.g. 2.6. */
    overBy: number
}

export function stageSlip(
    current: RunStep[] | undefined | null,
    previous: RunStep[] | undefined | null,
    nowMs: number,
): StageSlip | null {
    if (!Array.isArray(current) || !Array.isArray(previous)) return null
    const open = current.find(s => s.state === 'running' || s.state === 'waiting')
    if (!open) return null
    const was = previous.find(s => s.id === open.id)
    const expectedS = was && typeof was.secs === 'number' ? was.secs : 0
    if (expectedS <= 0) return null
    const elapsedS = describeStep(open, nowMs).elapsedS ?? 0
    if (elapsedS < expectedS * _SLIP_RATIO || elapsedS - expectedS < _SLIP_SECS) {
        return null
    }
    return {
        label: STEP_LABELS[open.id] ?? open.id,
        elapsedS,
        expectedS,
        overBy: elapsedS / expectedS,
    }
}

// ── where a source's runs go wrong ───────────────────────────────────────
//
// A column of red rows says runs fail. The ledger says WHERE, and one stage
// accounting for most of them is a different problem from failures spread
// across all of them.

/** One failure is an incident; a pattern needs at least two. */
const _PATTERN_MIN = 2

export interface FailurePattern {
    /** The stage most failures died in. */
    label: string
    count: number
    /** Finished runs considered (completed + failed + cancelled). */
    considered: number
}

export function commonFailureStage(
    runs: Array<{ status: string; runStats?: { steps?: RunStep[] } | null }>,
    limit = 10,
): FailurePattern | null {
    const finished = runs
        .filter(r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled')
        .slice(0, limit)
    if (finished.length === 0) return null
    const tally = new Map<string, number>()
    for (const run of finished) {
        const died = (run.runStats?.steps ?? []).find(
            s => s.state === 'failed' || s.state === 'cancelled',
        )
        if (!died) continue
        tally.set(died.id, (tally.get(died.id) ?? 0) + 1)
    }
    let top: [string, number] | null = null
    tally.forEach((count, id) => {
        if (!top || count > top[1]) top = [id, count]
    })
    if (!top || top[1] < _PATTERN_MIN) return null
    return {
        label: STEP_LABELS[top[0]] ?? top[0],
        count: top[1],
        considered: finished.length,
    }
}
