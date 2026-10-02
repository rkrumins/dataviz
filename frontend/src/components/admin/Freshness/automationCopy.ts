/**
 * The words the Automation modal speaks, the accent each stage wears, and the
 * contradictions it reports.
 *
 * One vocabulary — ① Detect, ② Check, ③ Act — used by the modal, the drawer,
 * the row chips and the run history. Every label derives from here so the
 * three surfaces cannot drift apart. The accents live here for the same reason:
 * the stage paints one segment of the spine and the junction feeding it paints
 * another, and they are different components that must not disagree about what
 * colour a stage is.
 */

export const STAGES = {
    detect: {
        // A plain digit, not ①: the numeral sits inside a filled disc on the
        // spine, and a circled glyph inside a circle reads as a mistake.
        n: '1',
        name: 'Detect',
        means: 'Watches each source for data changed by systems outside this app.',
        costs: 'Reads stored counts, not the data itself — cheap enough to run every minute.',
        whenOff: 'Nothing notices when another system changes a source, so Check has nothing new to judge and drift is found late or not at all.',
    },
    check: {
        n: '2',
        name: 'Check',
        means: 'Decides whether the rolled-up lineage still matches the data.',
        costs: 'Pure database work; never touches the graph.',
        whenOff: 'No source is judged, so drift is neither found nor shown — and nothing is rebuilt, because nothing is ever reported to rebuild.',
    },
    act: {
        n: '3',
        name: 'Act',
        means: 'Rebuilds the rolled-up lineage when it no longer matches.',
        costs: 'Minutes of work on the graph — throttled and capped on purpose.',
        // The control's own hint states what stops; this states what does
        // NOT, which is the half that makes the switch safe to reach for.
        whenOff: 'Drift is still found and still shown on every row, and anyone can still rebuild a source by hand.',
    },
} as const

/**
 * What a hold — any hold, at any scope — actually does. Three facts, in the
 * order a person needs them: what stops, what carries on regardless, and what
 * is never touched.
 *
 * One copy, because the confirmation, the modal's live read-out and the
 * runbook must not describe the same act differently. The middle line is the
 * one that makes a stop safe to reach for: a hold withholds REBUILDS and
 * nothing else — the watching, the judging and the reporting all continue,
 * which is why a paused fleet still shows you everything that is drifting.
 */
export const HOLD_EFFECT = {
    stops: 'No source is rebuilt automatically. Rolled-up lineage stays as it is and drifts further from the data as that data changes.',
    continues: 'Sources are still watched and still checked, drift is still shown on every row, and anyone can still rebuild a source by hand.',
    keeps: 'Nothing is deleted. Turning automation back on starts from a fresh check — no backlog of rebuilds is replayed.',
} as const

/** Backend bounds, in the one unit both surfaces speak. The server's floor for
 *  the check interval is 30s; this is stricter on purpose, because a sub-minute
 *  fleet check buys nothing the probe has not already found. */
export const MAX_SECS = 86400
export const MIN_PROBE_SECS = 15
export const MIN_CHECK_SECS = 60

/** Preset ladders per stage. Deliberately disjoint across the three stages:
 *  two stages offering the same chip is exactly the confusion this vocabulary
 *  exists to remove. They live here rather than in the modal because the
 *  per-source drawer edits the SAME three settings — a second ladder there
 *  would let one surface offer a value the other cannot. */
export const DETECT_PRESETS = [15, 30, 60, 600]
export const CHECK_PRESETS = [300, 1800, 3600, 21600]
export const COOLDOWN_PRESETS = [0, 900, 7200, MAX_SECS]

/** One string per cadence, used as BOTH the visible ledger label and the
 *  control's accessible name. Two copies would eventually disagree, and a
 *  control whose spoken name differs from the words printed beside it is a
 *  WCAG failure and a support call. */
export const CADENCE_LABEL = {
    detect: 'Look for changes every',
    check: 'Check every',
    act: 'Minimum time between rebuilds',
} as const

/** Accents progress along the pipeline — sky (observation) → indigo (judgment)
 *  → violet (execution) — so the palette itself carries the order.
 *
 *  They are spent on the diagram and the stage's left rule, never on a filled
 *  stage background: three filled panels would shout over the one thing that is
 *  actually live, the connector between two stages.
 *
 *  The pill in the rail and the section below it are different components that
 *  must not disagree about what colour a stage is, which is why they read from
 *  one table rather than hardcoding it twice. */
export const STAGE_ACCENT: Record<keyof typeof STAGES, {
    /** The rail pill while this stage is on. */
    pill: string
    /** The numeral's disc inside that pill. */
    disc: string
    /** The connector FEEDING this stage wears its accent. */
    line: string
    /** The 2px rule down the left of the stage's own section. */
    rule: string
}> = {
    detect: {
        pill: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-1 ring-inset ring-sky-500/30',
        disc: 'bg-sky-500', line: 'bg-sky-500/70', rule: 'border-l-sky-500/60',
    },
    check: {
        pill: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-500/30',
        disc: 'bg-indigo-500', line: 'bg-indigo-500/70', rule: 'border-l-indigo-500/60',
    },
    act: {
        pill: 'bg-violet-600/10 text-violet-700 dark:text-violet-300 ring-1 ring-inset ring-violet-500/30',
        disc: 'bg-violet-600', line: 'bg-violet-600/70', rule: 'border-l-violet-600/60',
    },
}

/** The four detectors, in the order the backend evaluates them. Each says what
 *  it looks for in the operator's terms, not the detector's — the codes
 *  (``overlay_missing`` and friends) never reach the screen.
 *
 *  They belong to ② Check, not ③ Act: they decide what counts as a finding,
 *  which is Check's job. The per-check cap decides how many rebuilds follow,
 *  which is Act's. */
export const DETECTORS: { key: string; label: string; hint: string }[] = [
    {
        key: 'overlay_missing',
        label: 'Rollups went missing',
        hint: 'A source that had rolled-up lineage now has none — usually a reload wiped it.',
    },
    {
        key: 'overlay_shrunk',
        label: 'Rollups shrank',
        hint: 'Far fewer rollups than the last build produced, with the underlying data unchanged.',
    },
    {
        key: 'never_aggregated',
        label: 'Never built',
        hint: 'An onboarded source with data and an ontology that has never had lineage built.',
    },
    {
        key: 'raw_drift',
        label: 'Counts changed',
        hint: 'Something outside the app changed the node or edge counts.',
    },
]

/** The id a ``SettingRow`` gives its hint, so the control in that row can point
 *  at it with ``aria-describedby``. One definition rather than a suffix spelled
 *  out at each call site, and it lives here because ``StageRow`` exports only
 *  components — a lone function beside them breaks fast refresh. */
export function hintIdFor(htmlFor: string): string {
    return `${htmlFor}-hint`
}

interface PolicyLike {
    enabled?: boolean | null
    detectors?: string[] | null
    maxActionsPerRun?: number | null
}
interface CadenceLike {
    probeEnabled?: boolean | null
}

/**
 * Combinations that are legal but almost certainly not intended. Derived, so
 * a settings change cannot leave a stale warning behind.
 */
export function automationWarnings(
    policy: PolicyLike | undefined,
    cadence: CadenceLike | undefined,
): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = []
    if (!policy?.enabled) return out

    if (cadence?.probeEnabled === false) {
        out.push({
            id: 'detect-off',
            text: 'Change detection is off, so checks only see data as fresh as the '
                + '15-minute statistics refresh.',
        })
    }
    // null means "all detectors on"; an EMPTY array is a real configuration
    // meaning "act on nothing". Must be tested with length, never truthiness.
    if (Array.isArray(policy.detectors) && policy.detectors.length === 0) {
        out.push({
            id: 'no-detectors',
            text: 'Nothing is acted on. Problems are still detected and shown in the table.',
        })
    }
    if (policy.maxActionsPerRun === 0) {
        out.push({
            // "Detect" is a stage name in this vocabulary, so it cannot also be
            // a plain verb here — a page whose whole premise is three fixed
            // words must not spend one of them on something else.
            id: 'cap-zero',
            text: 'Report only — no rebuilds will be queued.',
        })
    }
    return out
}

/** How long an operator can hold rebuilds for — a source's, a provider's or
 *  the fleet's. Hours and days, because a pause is measured in "until I have
 *  looked at it", never in seconds — which is why this is a list of choices
 *  and not a DurationField. Shared by every snooze control so the three
 *  scopes cannot drift apart. */
export const SNOOZE_CHOICES: { label: string; secs: number }[] = [
    { label: '1 hour', secs: 3600 },
    { label: '8 hours', secs: 8 * 3600 },
    { label: '24 hours', secs: 24 * 3600 },
    { label: '7 days', secs: 7 * 24 * 3600 },
]
