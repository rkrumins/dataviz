/**
 * rescueFixes — when a query matches nothing: where the matches run out,
 * and the smallest changes worth trying, mildest first.
 *
 *   Find Datasets                               13
 *     that feed a Dashboard within 1–3 hops      9
 *     and are tagged #Finance                    0   ← here
 *       → any Dashboard, not one tagged … · drop this line · match any
 *
 * Pure: the caller counts each fix and offers the ones that find
 * something.
 */
import type { Predicate, RelatedPredicate } from '@/types/search'

import type { ClauseCount } from '../counts/useClauseCounts'
import { findScopeCondition } from '../predicateComposition'
import { axisMeta, hopRange, maxHopsFor } from '../relations'
import { getAt, listedClauses, setAt, withCombine, type Path } from '../sentence/clauseModel'
import { isOrInside } from '../vocabulary/sentenceGrammar'


export type RescueFix =
    /** Look further along lineage. */
    | { kind: 'hops'; hops: number; predicate: Predicate }
    /** Any relative will do, not every one. */
    | { kind: 'anyRelative'; predicate: Predicate }
    /** At least one relative, not so many. */
    | { kind: 'fewer'; predicate: Predicate }
    /** Text that contains the words, not text that is exactly them. */
    | { kind: 'contains'; text: string; predicate: Predicate }
    /** Any of the conditions, not all of them. */
    | { kind: 'anyOf'; predicate: Predicate }
    /** Without the line where the matches run out. */
    | { kind: 'drop'; clause: number; predicate: Predicate }
    /** The whole view, not only inside a container. */
    | { kind: 'wholeView'; predicate: Predicate }


/** The listed clause where the matches run out: the first whose running
 *  total is nothing, else the first that matches nothing by itself —
 *  the subject first, as the Sentence lists them. */
export function emptyingClause(clauses: readonly ClauseCount[]): number | null {
    const narrowed = clauses.findIndex((c) => c.cumulative?.complete && c.cumulative.count === 0)
    if (narrowed >= 0) return narrowed
    const alone = clauses.findIndex((c) => c.alone?.complete && c.alone.count === 0)
    return alone >= 0 ? alone : null
}


/** Where the ``i``-th listed clause lives in the draft. */
function listedPath(draft: Predicate, i: number): Path | null {
    const { subject, clauses } = listedClauses(draft)
    if (subject) return i === 0 ? [{ child: 0 }] : clauses[i - 1]?.path ?? null
    return clauses[i]?.path ?? null
}

/** A container the query is clamped to — "inside Finance" — as the
 *  path of its listed clause. */
function scopePath(draft: Predicate): Path | null {
    const { clauses } = listedClauses(draft)
    const scope = findScopeCondition(draft)
    for (const { predicate, path } of clauses) {
        if (predicate === scope) return path
        if (predicate.kind === 'related' && predicate.axis === 'ancestor' && !predicate.quantifier && predicate.where
            && (predicate.where.kind === 'is' || isOrInside(predicate.where))) return path
    }
    return null
}


export function rescueFixes(draft: Predicate, clause: number): RescueFix[] {
    const path = listedPath(draft, clause)
    if (!path) return []
    const { combine, clauses } = listedClauses(draft)
    const target = getAt(draft, path)
    const fixes: RescueFix[] = []
    // A clause replaced always leaves a query.
    const replace = (next: Predicate) => setAt(draft, path, next) ?? next

    if (target?.kind === 'related') {
        const rel: RelatedPredicate = target
        if (axisMeta(rel.axis).lineage) {
            const most = maxHopsFor(rel, { topLevel: combine === 'and', rule: false })
            if (hopRange(rel)[1] < most) fixes.push({ kind: 'hops', hops: most, predicate: replace({ ...rel, maxHops: most }) })
        }
        if (rel.quantifier === 'all') {
            const any = { ...rel }
            delete any.quantifier
            fixes.push({ kind: 'anyRelative', predicate: replace(any) })
        }
        if (rel.count && (rel.count.op ?? 'gte') !== 'lt' && (rel.count.op ?? 'gte') !== 'lte' && rel.count.value > 1) {
            fixes.push({ kind: 'fewer', predicate: replace({ ...rel, count: { op: 'gte', value: 1 } }) })
        }
    }
    if (target?.kind === 'text' && target.match && target.match !== 'substring' && target.match !== 'fulltext') {
        fixes.push({ kind: 'contains', text: target.value, predicate: replace({ ...target, match: 'substring' }) })
    }
    if (combine === 'and' && clauses.length >= 2) {
        const any = withCombine(draft, 'or')
        if (any) fixes.push({ kind: 'anyOf', predicate: any })
    }
    const dropped = setAt(draft, path, null)
    if (dropped) fixes.push({ kind: 'drop', clause, predicate: dropped })
    const scope = scopePath(draft)
    if (scope && JSON.stringify(scope) !== JSON.stringify(path)) {
        const whole = setAt(draft, scope, null)
        if (whole) fixes.push({ kind: 'wholeView', predicate: whole })
    }
    return fixes
}
