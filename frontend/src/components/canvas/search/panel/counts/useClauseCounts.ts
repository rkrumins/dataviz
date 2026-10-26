/**
 * useClauseCounts — a query's counts clause by clause: how many each
 * clause matches alone, how the matches narrow as each is added, how many
 * relatives a relationship can reach, and the whole query's total.
 */
import { useMemo } from 'react'

import type { Predicate } from '@/types/search'

import { planClauseCounts } from './clauseItems'
import type { Uncountable } from './countable'
import { useCounts, type CountsStatus, type CountState, type UseCountsOptions } from './useCounts'


export interface ClauseCount {
    /** The clause by itself. */
    alone: CountState | null
    /** The clauses up to and including this one. */
    cumulative: CountState | null
    /** What its relationship's relatives must be. */
    where: CountState | null
    /** Why it has no count, when it can't be counted. */
    reason: Uncountable | null
}

export interface ClauseCounts {
    clauses: ClauseCount[]
    total: CountState | null
    status: CountsStatus
}


export function useClauseCounts(
    viewId: string | null,
    draft: Predicate | null,
    opts?: UseCountsOptions,
): ClauseCounts {
    const plan = useMemo(() => planClauseCounts(draft), [draft])
    const { counts, status } = useCounts(viewId, plan.items, opts)
    return useMemo(() => {
        const of = (id: string | null) => (id ? counts.get(id) ?? null : null)
        return {
            clauses: plan.clauses.map((c) => ({
                alone: of(c.alone), cumulative: of(c.prefix), where: of(c.where), reason: c.reason,
            })),
            total: of(plan.total),
            status,
        }
    }, [plan, counts, status])
}
