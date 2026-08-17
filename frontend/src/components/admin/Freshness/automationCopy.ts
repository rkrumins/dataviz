/**
 * The words the Automation modal speaks, the accent each stage wears, and the
 * contradictions it reports.
 *
 * One vocabulary — ① Detect, ② Check, ③ Act — used by the modal, the drawer,
 * the row chips and the run history. Every label derives from here so the
 * three surfaces cannot drift apart. The accents live here for the same reason:
 * the card paints one and the connector feeding it paints another, and they are
 * different components that must not disagree about what colour a stage is.
 */

export const STAGES = {
    detect: {
        n: '①',
        name: 'Detect',
        means: 'Watches each source for data changed by systems outside this app.',
        costs: 'Reads stored counts, not the data itself — cheap enough to run every minute.',
    },
    check: {
        n: '②',
        name: 'Check',
        means: 'Decides whether the rolled-up lineage still matches the data.',
        costs: 'Pure database work; never touches the graph.',
    },
    act: {
        n: '③',
        name: 'Act',
        means: 'Rebuilds the rolled-up lineage when it no longer matches.',
        costs: 'Minutes of work on the graph — throttled and capped on purpose.',
    },
} as const

/** Accents progress along the pipeline — sky (observation) → indigo (judgment)
 *  → violet (execution) — so the palette itself carries the order. They appear
 *  as a 2px left rule and the numeral, never as a filled card: three filled
 *  cards would shout over the one thing that is actually live, the connector. */
export const STAGE_ACCENT: Record<keyof typeof STAGES, {
    rule: string
    numeral: string
    /** The connector FEEDING this stage wears its accent. */
    line: string
    arrow: string
}> = {
    detect: {
        rule: 'border-l-sky-500', numeral: 'text-sky-500/35',
        line: 'border-sky-500/60', arrow: 'text-sky-500/80',
    },
    check: {
        rule: 'border-l-indigo-500', numeral: 'text-indigo-500/35',
        line: 'border-indigo-500/60', arrow: 'text-indigo-500/80',
    },
    act: {
        rule: 'border-l-violet-600', numeral: 'text-violet-600/35',
        line: 'border-violet-600/60', arrow: 'text-violet-600/80',
    },
}

/** The four detectors, in the order the backend evaluates them. Each says what
 *  it looks for in the operator's terms, not the detector's — the codes
 *  (``overlay_missing`` and friends) never reach the screen. */
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
