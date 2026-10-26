/**
 * countable — whether the server can count a condition, decided before it
 * is sent. `/search/counts` validates a request's conditions together, so
 * one it refuses — a value not filled in yet, lineage further than a search
 * may test — would cost every other count in the request. These mirror the
 * server's refusals (`advanced_search_service._validate_predicate`), for a
 * search's conditions (`purpose: 'search'`).
 */
import type { Predicate } from '@/types/search'

import { isRowIncomplete } from '../ConditionRow'
import { axisMeta, hopRange, maxHopsFor, RELATION_DEPTH_MAX } from '../relations'


/** Why a condition has no count, in the words a count's place shows. */
export type Uncountable =
    /** A route search answers with routes, not a number of entities. */
    | 'route'
    /** Something in it is still to be filled in. */
    | 'unfinished'
    /** It follows lineage further than a search tests from every entity. */
    | 'too-far'
    /** Relationships inside relationships, deeper than the server allows. */
    | 'too-deep'

export const UNCOUNTABLE_WORDS: Record<Uncountable, string> = {
    route: 'Routes are found when the search runs',
    unfinished: 'Counted once it is filled in',
    'too-far': 'Too many hops to count — name the far end to go further',
    'too-deep': 'Nested too deep to count',
}


/** Why ``p`` can't be counted as a search's condition, or null when it can.
 *  ``topLevel``: it stands in the query's top-level AND (where a
 *  relationship naming its far end may walk further). */
export function whyUncountable(p: Predicate, topLevel = true): Uncountable | null {
    return walk(p, topLevel, 0)
}

function walk(p: Predicate, topLevel: boolean, relations: number): Uncountable | null {
    if (p.kind === 'group') {
        const op = p.op ?? 'and'
        if (p.children.length === 0 || (op === 'not' && p.children.length !== 1)) return 'unfinished'
        for (const child of p.children) {
            const why = walk(child, topLevel && op === 'and', relations)
            if (why) return why
        }
        return null
    }
    if (p.kind === 'path') return 'route'
    if (relations > 0 && (p.kind === 'descendantOf' || p.kind === 'withinHops')) return 'unfinished'
    if (p.kind === 'related') {
        if (relations + 1 > RELATION_DEPTH_MAX) return 'too-deep'
        if (axisMeta(p.axis).lineage && hopRange(p)[1] > maxHopsFor(p, { topLevel, rule: false })) {
            return 'too-far'
        }
        return p.where ? walk(p.where, false, relations + 1) : null
    }
    return isRowIncomplete(p) ? 'unfinished' : null
}
