/**
 * clauseItems — the counts a query's clauses are read with, planned as one
 * request's worth of items:
 *
 *   alone   each clause by itself — "1,204 are tagged PII" — or, for a
 *           subject's any-of clauses, within the subject: "86 Datasets
 *           are tagged PII"
 *   prefix  the clauses up to each one, in order — how the matches narrow
 *           as each clause is added (an all-of query's only)
 *   where   what a relationship's relatives must be — "12 dashboards"
 *   total   the whole query, as it runs
 *
 * Identical conditions share one item (a first clause alone IS the first
 * prefix), so a query of n clauses costs at most 3n items, and never more
 * than the 32 one request takes.
 */
import type { Predicate } from '@/types/search'

import { requestPredicate } from '../../searchRequest'
import { isRowIncomplete } from '../ConditionRow'
import { buildRunnablePredicate } from '../runnablePredicate'
import { listedClauses } from '../sentence/clauseModel'

import { whyUncountable, type Uncountable } from './countable'


/** The server takes at most this many conditions to count per request. */
export const COUNT_ITEMS_MAX = 32

export interface CountItem {
    id: string
    predicate: Predicate
}

/** One listed clause's counts, by item id (null: no count to ask for) —
 *  the subject first, when the query has one, as the Sentence lists them. */
export interface ClauseCountIds {
    alone: string | null
    /** The clauses up to and including this one. */
    prefix: string | null
    /** Its relationship's relatives, when it is one with a condition. */
    where: string | null
    /** Why ``alone`` is null, when the clause can't be counted. */
    reason: Uncountable | null
}

export interface ClausePlan {
    items: CountItem[]
    clauses: ClauseCountIds[]
    total: string | null
}


/** A short, stable id for a condition as a request carries it — two
 *  32-bit hashes of its JSON, so ids stay well under the 128 the server
 *  allows, and the same condition is always the same item. */
export function countId(p: Predicate): string {
    const text = JSON.stringify(requestPredicate(p))
    let a = 0x811c9dc5
    let b = 5381
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        a = Math.imul(a ^ c, 0x01000193)
        b = (Math.imul(b, 33) + c) | 0
    }
    return `c${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}


export function planClauseCounts(draft: Predicate | null): ClausePlan {
    const items = new Map<string, CountItem>()
    const ask = (p: Predicate): string | null => {
        const id = countId(p)
        if (!items.has(id)) {
            if (items.size >= COUNT_ITEMS_MAX) return null
            items.set(id, { id, predicate: requestPredicate(p) })
        }
        return id
    }

    const listed = listedClauses(draft)
    const subject = listed.subject?.predicate ?? null
    const conditions = [...(subject ? [subject] : []), ...listed.clauses.map((c) => c.predicate)]
    // The whole query first, so the number that matters most never falls
    // past the cap.
    const runnable = buildRunnablePredicate(draft)
    const total = runnable && !whyUncountable(runnable.predicate) ? ask(runnable.predicate) : null

    const allOf = conditions.length > 1 && listed.combine === 'and'
    // A subject's any-of clauses each count within it: "Datasets tagged
    // PII", not everything tagged PII.
    const within = (c: Predicate, i: number): Predicate => (subject && !allOf && i > 0
        ? { kind: 'group', op: 'and', children: [subject, c] } : c)
    const clauses: ClauseCountIds[] = conditions.map((c, i) => {
        const p = within(c, i)
        const reason = whyUncountable(p)
        return { alone: reason ? null : ask(p), prefix: null, where: null, reason }
    })

    // How the matches narrow: each complete clause added in turn. A clause
    // still being filled in is skipped, as the run skips it; one that can't
    // be counted ends the funnel there.
    if (allOf) {
        const sofar: Predicate[] = []
        for (let i = 0; i < conditions.length; i++) {
            if (isRowIncomplete(conditions[i])) continue
            if (clauses[i].reason) break
            sofar.push(conditions[i])
            clauses[i].prefix = sofar.length === 1
                ? clauses[i].alone
                : ask({ kind: 'group', op: 'and', children: [...sofar] })
        }
    } else if (conditions.length === 1) {
        clauses[0].prefix = clauses[0].alone
    }

    // What each relationship's relatives must be — the map's far node.
    conditions.forEach((c, i) => {
        if (c.kind === 'related' && c.where && !whyUncountable(c.where)) clauses[i].where = ask(c.where)
    })

    return { items: [...items.values()], clauses, total }
}
