/**
 * What in the selection deserves a second look, read from the summary.
 *
 * Only from facts the summary holds: a source people keep operating by hand,
 * a source only one person ever operates, manual work rising sharply, changes
 * that mostly do not say why. `ActivityAttention` draws them.
 */
import { exact, percent } from '@/lib/formatMetric'
import type { ActivityPersonRef, ActivitySummary } from '@/services/activityService'

import { cadencePhrase } from './activityMeta'
import type { ActivityParamPatch } from './useActivityParams'

/** A source operated by hand at least daily, at the usual gap, is toil… */
const TOIL_GAP_HOURS = 24
/** …once it has been operated often enough for a gap to mean something. */
const MIN_OPERATIONS = 5
/** Changes needed before the share that gave a reason says anything. */
const MIN_CHANGES = 10
const REASON_SHARE = 0.5
/** Manual operations up by at least half, from enough to be a pattern. */
const SURGE = 0.5
const MIN_SURGE_OPERATIONS = 10
const MAX_ITEMS = 3

export type AttentionKind = 'toil' | 'one-person' | 'surge' | 'reasons'

export interface AttentionItem {
    id: string
    kind: AttentionKind
    title: string
    detail: string
    /** The filter that narrows the explorer to what the item is about. */
    show: ActivityParamPatch
}

type Source = ActivitySummary['handsOnSources'][number]

const sourceName = (s: Source) => s.name || s.dataSourceId
const personName = (p: ActivityPersonRef) => p.name || p.email || p.id
/** The one person behind every manual operation on a source, if there is one. */
const soleOperator = (s: Source) =>
    s.people?.length === 1 && s.people[0].count === s.count ? s.people[0] : null

/**
 * The callouts for a summary, most actionable first. `personFiltered`: the
 * selection is one person's, so "only they operate it" is true of every
 * source and says nothing.
 */
export function attentionItems(summary: ActivitySummary, { personFiltered = false } = {}): AttentionItem[] {
    const items: AttentionItem[] = []
    const busy = summary.handsOnSources.filter((s) => s.count >= MIN_OPERATIONS)

    const toil = busy
        .filter((s) => s.medianGapHours !== null && s.medianGapHours <= TOIL_GAP_HOURS)
        .sort((a, b) => a.medianGapHours! - b.medianGapHours!)
        .slice(0, 2)
    for (const s of toil) {
        const only = personFiltered ? null : soleOperator(s)
        items.push({
            id: `toil:${s.dataSourceId}`,
            kind: 'toil',
            title: `${sourceName(s)} is run by hand ${cadencePhrase(s.medianGapHours)}`,
            detail: `${exact(s.count)} manual operations in this range${only ? `, all by ${personName(only)}` : ''}. `
                + 'A schedule could take this over.',
            show: { dataSource: s.dataSourceId },
        })
    }

    const carried = personFiltered ? undefined : busy.find((s) => !toil.includes(s) && soleOperator(s))
    if (carried) {
        items.push({
            id: `one-person:${carried.dataSourceId}`,
            kind: 'one-person',
            title: `Only ${personName(soleOperator(carried)!)} operates ${sourceName(carried)}`,
            detail: `All ${exact(carried.count)} manual operations in this range. No one else has run it.`,
            show: { dataSource: carried.dataSourceId },
        })
    }

    const ops = summary.totals.operations
    if (ops.delta !== null && ops.delta >= SURGE && ops.current >= MIN_SURGE_OPERATIONS) {
        items.push({
            id: 'surge',
            kind: 'surge',
            title: `Manual operations are up ${percent(ops.delta)}`,
            detail: `${exact(ops.current)} in this range against ${exact(ops.previous ?? 0)} the period before. `
                + 'Something upstream may need fixing.',
            show: { lens: 'operations', types: null },
        })
    }

    const reasons = summary.totals.reasons
    if (reasons.share !== null && reasons.of >= MIN_CHANGES && reasons.share < REASON_SHARE) {
        items.push({
            id: 'reasons',
            kind: 'reasons',
            title: 'Most changes don’t say why',
            detail: `Only ${exact(reasons.given)} of ${exact(reasons.of)} changes in this range gave a reason.`,
            show: { reason: 'missing' },
        })
    }

    return items.slice(0, MAX_ITEMS)
}
