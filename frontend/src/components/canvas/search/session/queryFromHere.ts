/**
 * queryFromHere — the questions a right-click on the canvas asks about the
 * entities under it, each an ordinary query the search panel opens on:
 *
 *   one entity    everything inside it · its children · what feeds it ·
 *                 what it feeds · routes from it to… (finished in the builder)
 *   several       what they all feed · what feeds them all
 *
 * Each names its entities by URN in a relationship whose far end is an
 * `is`: the server walks from them (an anchored relationship) instead of
 * testing every entity in the view, so the answers are quick and exact.
 * For a container the far end is "is it, or is inside it" — a dataset's
 * lineage runs through its columns — and the server walks from everything
 * inside it just the same.
 *
 * And for a match the panel lists: how it matches — the routes from it to
 * the relatives a lineage relationship in the query found.
 */
import type { PathPredicate, Predicate, RelatedPredicate } from '@/types/search'

import { axisMeta, hopRange } from '../panel/relations'


/** Lineage hops the canvas questions follow — the panel row edits them. */
export const FROM_HERE_HOPS = 3
/** Beyond this many entities, "all of them" questions aren't offered. */
export const FROM_HERE_MAX_SHARED = 8
/** How far a route may go when one end is a condition (`PathPredicate`). */
const ROUTE_MAX_HOPS = 4
/** …and when both ends are: a container's routes start from a condition. */
const ROUTE_MAX_HOPS_BOTH = 3

export interface FromHereQuestion {
    id: string
    label: string
    /** A Lucide icon name. */
    icon: string
    predicate: Predicate
    /** Unfinished: opens in the builder rather than running. */
    refine?: boolean
}


/** What a relative must be: the entity — or, for a container, the entity or
 *  anything inside it. */
function relativeIs(urn: string, container: boolean): Predicate {
    const is: Predicate = { kind: 'is', refs: [{ urn }] }
    return container
        ? { kind: 'group', op: 'or', children: [is, { kind: 'related', axis: 'ancestor', where: is }] }
        : is
}


function anchored(axis: RelatedPredicate['axis'], urn: string, hops = 1,
                  container = false): RelatedPredicate {
    return {
        kind: 'related', axis, ...(hops > 1 ? { maxHops: hops } : {}),
        where: relativeIs(urn, container),
    }
}


/** The questions for the entities right-clicked (the selection, when the
 *  entity is part of one). ``readOnly``: a shared link's, which may only
 *  search inside its view — relationships and routes reach outside it.
 *  ``containers``: which of them hold other entities, whose lineage
 *  questions take in what is inside them. */
export function questionsFromHere(
    urns: string[],
    { readOnly = false, containers = new Set<string>() }: {
        readOnly?: boolean; containers?: ReadonlySet<string>
    } = {},
): FromHereQuestion[] {
    if (urns.length === 0) return []
    if (urns.length === 1) {
        const [urn] = urns
        const container = containers.has(urn)
        const inside: FromHereQuestion = {
            id: 'inside', label: 'Everything inside this', icon: 'FolderTree',
            predicate: { kind: 'descendantOf', urns: [urn], uiScope: 'any' } as Predicate,
        }
        if (readOnly) return [inside]
        return [
            inside,
            { id: 'children', label: 'Its children', icon: 'ListTree', predicate: anchored('parent', urn) },
            {
                id: 'sources', label: 'What feeds this', icon: 'GitMerge',
                predicate: anchored('downstream', urn, FROM_HERE_HOPS, container),
            },
            {
                id: 'targets', label: 'What this feeds', icon: 'Workflow',
                predicate: anchored('upstream', urn, FROM_HERE_HOPS, container),
            },
            {
                id: 'routes', label: 'Routes from this to…', icon: 'Route', refine: true,
                predicate: container
                    ? {
                        kind: 'path', sourceUrns: [], targetUrns: [], maxHops: ROUTE_MAX_HOPS_BOTH,
                        direction: 'outgoing', edgeClass: 'lineage',
                        sourceWhere: relativeIs(urn, true),
                        targetWhere: { kind: 'entityType', op: 'in', values: [] },
                    }
                    : {
                        kind: 'path', sourceUrns: [urn], targetUrns: [], maxHops: ROUTE_MAX_HOPS,
                        direction: 'outgoing', edgeClass: 'lineage',
                        targetWhere: { kind: 'entityType', op: 'in', values: [] },
                    },
            },
        ]
    }
    if (readOnly || urns.length > FROM_HERE_MAX_SHARED) return []
    const all = (axis: RelatedPredicate['axis']): Predicate => ({
        kind: 'group', op: 'and',
        children: urns.map((urn) => anchored(axis, urn, FROM_HERE_HOPS, containers.has(urn))),
    })
    return [
        { id: 'shared-targets', label: `What all ${urns.length} feed`, icon: 'Workflow', predicate: all('upstream') },
        { id: 'shared-sources', label: `What feeds all ${urns.length}`, icon: 'GitMerge', predicate: all('downstream') },
    ]
}


/** The routes that show how ``urn`` matched ``predicate``: from it to the
 *  relatives the query's first lineage relationship looks for, along the
 *  edges it walks — or null when the query has none to show. */
export function howItMatches(predicate: Predicate | null, urn: string): PathPredicate | null {
    const relation = firstLineageRelation(predicate)
    if (!relation) return null
    const [, hi] = hopRange(relation)
    return {
        kind: 'path', sourceUrns: [urn], targetUrns: [],
        // Upstream relatives feed the match: the route runs against lineage.
        direction: relation.axis === 'upstream' ? 'incoming' : relation.axis === 'downstream' ? 'outgoing' : 'any',
        edgeClass: 'lineage',
        maxHops: Math.min(hi, ROUTE_MAX_HOPS),
        ...(relation.edgeTypes?.length ? { edgeTypes: relation.edgeTypes } : {}),
        ...(relation.edge ? { edgePredicate: relation.edge } : {}),
        targetWhere: relation.where ?? { kind: 'all' },
    }
}


/** A lineage relationship the match had relatives for: in the top-level
 *  AND, not "none" (no relative to show). */
function firstLineageRelation(p: Predicate | null): RelatedPredicate | null {
    if (!p) return null
    const members = p.kind === 'group' && (p.op ?? 'and') === 'and' ? p.children : [p]
    for (const m of members) {
        if (m.kind === 'related' && axisMeta(m.axis).lineage && m.quantifier !== 'none') return m
    }
    return null
}
