/**
 * useRescue — when the query matches nothing, the line where the matches
 * run out and up to three fixes that each find something, counted.
 */
import { useMemo } from 'react'

import type { Predicate } from '@/types/search'

import { requestPredicate } from '../../searchRequest'
import { countId, type CountItem } from '../counts/clauseItems'
import { whyUncountable } from '../counts/countable'
import type { ClauseCounts } from '../counts/useClauseCounts'
import { useCounts, type CountsStatus, type CountState } from '../counts/useCounts'
import { buildSentence } from '../sentence/clauseModel'
import { lineText } from '../sentence/lineWords'
import { useTypeName } from '../sentence/useTypeName'

import { emptyingClause, rescueFixes, type RescueFix } from './rescueFixes'


export type CountedFix = RescueFix & { count: CountState }

export interface Rescue {
    /** The listed clause where the matches run out, or null. */
    clause: number | null
    /** What that line says: "are tagged #PII". */
    line: string | null
    /** The fixes that find something, mildest first, three at most. */
    fixes: CountedFix[]
    status: CountsStatus
}

const FIXES_SHOWN = 3


export function useRescue(viewId: string | null, draft: Predicate | null, counts: ClauseCounts): Rescue {
    const clause = useMemo(() => (draft ? emptyingClause(counts.clauses) : null), [draft, counts.clauses])
    const candidates = useMemo(() => (draft && clause !== null ? rescueFixes(draft, clause) : []), [draft, clause])
    const items = useMemo(() => {
        const out = new Map<string, CountItem>()
        for (const f of candidates) {
            if (whyUncountable(f.predicate)) continue
            const id = countId(f.predicate)
            if (!out.has(id)) out.set(id, { id, predicate: requestPredicate(f.predicate) })
        }
        return [...out.values()]
    }, [candidates])
    const { counts: found, status } = useCounts(viewId, items, { debounceMs: 300, enabled: items.length > 0 })
    const fixes = useMemo(() => {
        const seen = new Set<string>()
        return candidates.flatMap((f) => {
            const id = countId(f.predicate)
            const count = found.get(id)
            if (!count || count.count === 0 || seen.has(id)) return []
            seen.add(id)
            return [{ ...f, count }]
        }).slice(0, FIXES_SHOWN)
    }, [candidates, found])
    const typeName = useTypeName()
    const line = useMemo(() => {
        if (!draft || clause === null) return null
        const at = buildSentence(draft).lines.find((l) => l.topIndex === clause)
        return at ? lineText(at, typeName) : null
    }, [draft, clause, typeName])
    return { clause, line, fixes, status }
}
