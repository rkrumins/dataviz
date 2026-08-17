/**
 * The words the Automation panel speaks, and the contradictions it reports.
 *
 * One vocabulary — ① Detect, ② Check, ③ Act — used by the panel, the drawer,
 * the row chips and the run history. Every label derives from here so the
 * three surfaces cannot drift apart.
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
