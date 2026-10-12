/**
 * What "Resume from cursor" will actually redo.
 *
 * The cursor is `v3:{run_start_ms}:{phase}:{pos}`, and the phase in it
 * decides how much of the run is skipped. Resume saves the WRITES, not the
 * SCAN: EXTRACT and COMPUTE always re-run, because they are deterministic
 * and take minutes while APPLY takes the hours, and skipping them would mean
 * spilling and reloading the whole accumulator.
 *
 * Without this the dialog said only "Resume from cursor", and an operator
 * resuming a job that died at 80% watched the bar go to 0 and climb — which
 * is correct, and looks exactly like the resume not having worked.
 */
export interface ResumePlan {
    /** The cursor's phase: aggregate | reconcile | apply. */
    phase: string
    /** One sentence: what it picks up, and what it pays again. */
    detail: string
}

const _PLAN: Record<string, string> = {
    aggregate:
        'It stopped before any rollups were compared, so this starts the scan again from the beginning — the same as a fresh run, without re-reading the settings.',
    reconcile:
        'It picks up the comparison where it stopped. The lineage scan and the rollup computation run again first — they are deterministic and take minutes — so the progress bar starts from zero and climbs back.',
    apply:
        'It keeps every aggregated edge already written; only the ones still missing are created. The scan, the rollup computation and the full comparison run again first, so the progress bar starts from zero and climbs back.',
}

export function resumePlan(cursor: string | null | undefined): ResumePlan | null {
    if (!cursor) return null
    const parts = String(cursor).split(':')
    // Anything else is a legacy or malformed cursor: the pipeline starts a
    // fresh run from it, which is always safe, and saying nothing is better
    // than promising a pick-up that will not happen.
    if (parts.length !== 4 || parts[0] !== 'v3') return null
    const phase = parts[2]
    const detail = _PLAN[phase]
    return detail ? { phase, detail } : null
}
