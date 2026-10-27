/**
 * findMode — what the panel finds: entities, or the connections between
 * them (a Connections search, ``kind: 'edges'`` — the whole query). The
 * mode is the draft's own kind, so there is no second state to drift from
 * it: switching rewrites the draft, as one step of the undo history.
 */
import type { EdgesPredicate, Predicate } from '@/types/search'

import { rootGroupOp, topLevelConditions } from './predicateComposition'
import { stringifyPredicate } from './predicateDsl'
import { axisMeta, hopRange, maxHopsFor } from './relations'


export type FindMode = 'entities' | 'connections'

export function findModeOf(draft: Predicate | null): FindMode {
    return draft?.kind === 'edges' ? 'connections' : 'entities'
}


/** Why a Connections search makes no display rule. */
export const NO_RULE_FOR_CONNECTIONS = 'A display rule tags entities, and this search finds connections — '
    + 'make a rule from its From or To conditions as an entity search'

/** A saved or shared query as the panel's draft: a Connections search sent
 *  in an AND group of its own — the API reference asks a root to be sent
 *  in one — is the search itself. */
export function asDraft(p: Predicate): Predicate {
    const only = p.kind === 'group' && (p.op ?? 'and') === 'and' && p.children.length === 1 ? p.children[0] : null
    return only?.kind === 'edges' ? only : p
}

/** A query as a library row reads it: its Code-mode text, or for a
 *  Connections search, its two ends' either side of an arrow. */
export function queryLabel(p: Predicate): string {
    const q = asDraft(p)
    if (q.kind !== 'edges') return stringifyPredicate(p)
    const end = (where: Predicate | null | undefined) => (where ? stringifyPredicate(where) : 'anything')
    return `${end(q.sourceWhere)} → ${end(q.targetWhere)}`
}


/** What a switch rewrote the draft to, and what it left out — named, so
 *  the panel can say so. */
export interface Switched<P> {
    next: P
    dropped: string[]
}

/**
 * The draft as a Connections search: its conditions say where the
 * connections start (From). What one edge can't hold is left out: a route
 * (a path, within N hops) and lineage followed further than an end may.
 * "Every entity" is what an empty end already means.
 */
export function toConnections(draft: Predicate | null): Switched<EdgesPredicate> {
    const kept: Predicate[] = []
    const dropped: string[] = []
    for (const c of topLevelConditions(draft)) {
        if (c.kind === 'path') dropped.push('a path search')
        else if (c.kind === 'withinHops') dropped.push('“within N hops”')
        else if (c.kind === 'related' && axisMeta(c.axis).lineage
            && hopRange(c)[1] > maxHopsFor(c, { topLevel: false, rule: false })) {
            dropped.push(`lineage followed ${hopRange(c)[1]} steps`)
        } else if (c.kind !== 'all') kept.push(c)
    }
    // A NOT at the root is one condition (the group itself), so several
    // are always all of, or any of.
    const from: Predicate | null = kept.length === 0 ? null
        : kept.length === 1 ? kept[0]
        : { kind: 'group', op: rootGroupOp(draft) === 'or' ? 'or' : 'and', children: kept }
    return { next: from ? { kind: 'edges', sourceWhere: from } : { kind: 'edges' }, dropped }
}

/** The draft as an entity search: its From conditions. Its To conditions
 *  and the edges it goes through are left out. */
export function toEntities(draft: EdgesPredicate): Switched<Predicate | null> {
    const dropped: string[] = []
    if (draft.targetWhere) dropped.push('the To conditions')
    if (draft.edgeTypes || draft.edgeClass || draft.edgePredicate || draft.direction === 'either') {
        dropped.push('the edges it goes through')
    }
    return { next: draft.sourceWhere ?? null, dropped }
}
