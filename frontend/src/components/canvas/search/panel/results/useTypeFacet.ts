/**
 * useTypeFacet — the types a search's matches come in, each with how many,
 * to narrow the query by. Counted from the rows when every match is
 * loaded; otherwise each type is counted as the query AND that type,
 * the loaded rows standing in as a floor until the counts land.
 *
 * Never through the search's own aggregations: a facet there is counted
 * over the capped candidate set, and asking for one holds back the
 * canvas's container badges.
 */
import { useMemo } from 'react'

import type { Predicate, SearchHit } from '@/types/search'

import { requestPredicate } from '../../searchRequest'
import { countId } from '../counts/clauseItems'
import { useCounts, type CountState } from '../counts/useCounts'


export interface TypeFacet {
    type: string
    count: CountState
}

const FACETS_MAX = 12

const ofType = (query: Predicate, type: string): Predicate => ({
    kind: 'group', op: 'and', children: [
        ...(query.kind === 'group' && query.op === 'and' ? query.children : [query]),
        { kind: 'entityType', op: 'in', values: [type] },
    ],
})


export function useTypeFacet(viewId: string | null, query: Predicate | null, hits: readonly SearchHit[],
    total: number | null): TypeFacet[] {
    const loaded = useMemo(() => {
        const by = new Map<string, number>()
        for (const h of hits) if (h.node.entityType) by.set(h.node.entityType, (by.get(h.node.entityType) ?? 0) + 1)
        return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, FACETS_MAX)
    }, [hits])
    const everyMatch = total !== null && hits.length >= total
    const items = useMemo(() => (everyMatch || !query ? [] : loaded.map(([type]) => {
        const p = ofType(query, type)
        return { id: countId(p), predicate: requestPredicate(p) }
    })), [everyMatch, query, loaded])
    const { counts } = useCounts(viewId, items, { enabled: items.length > 0 })
    return useMemo(() => loaded.map(([type, n]) => ({
        type,
        count: everyMatch || !query
            ? { count: n, complete: everyMatch }
            : counts.get(countId(ofType(query, type))) ?? { count: n, complete: false },
    })), [loaded, everyMatch, query, counts])
}


/** ``draft`` leaving out entities of ``type`` — added to its "not these
 *  types" line when it has one. */
export function excludingType(draft: Predicate | null, type: string): Predicate {
    const none: Predicate = { kind: 'entityType', op: 'notIn', values: [type] }
    if (!draft) return none
    const children = draft.kind === 'group' && draft.op === 'and' ? draft.children : [draft]
    const at = children.findIndex((c) => c.kind === 'entityType' && c.op === 'notIn')
    if (at >= 0) {
        const existing = children[at] as Extract<Predicate, { kind?: 'entityType' }>
        if (existing.values.includes(type)) return draft
        return { kind: 'group', op: 'and', children: children.map((c, i) => (i === at
            ? { ...existing, values: [...existing.values, type] } : c)) }
    }
    return { kind: 'group', op: 'and', children: [...children, none] }
}
