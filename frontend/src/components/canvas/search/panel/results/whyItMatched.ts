/**
 * whyItMatched — which of a query's alternatives a result meets. In an
 * all-of query every row meets every line, and the query above the rows
 * already says so; in an any-of query the reader wants to know which one
 * brought each row in.
 *
 * What a row met is read from the row itself — its type, tags and
 * properties — or, for text, from the server's own account of the
 * conditions it matched (`matchedPredicates`: leaves numbered depth
 * first through groups). A line the row can't speak for (a relationship,
 * a lineage shape) is left unsaid rather than guessed.
 */
import type { Predicate, SearchHit } from '@/types/search'

import { listedClauses } from '../sentence/clauseModel'


/** Each leaf's number, as the server counts them. */
function leafNumbers(p: Predicate): Map<Predicate, number> {
    const out = new Map<Predicate, number>()
    let n = 0
    const walk = (q: Predicate) => {
        if (q.kind === 'group') q.children.forEach(walk)
        else out.set(q, n++)
    }
    walk(p)
    return out
}

/** Whether the row meets ``p`` — or null when the row can't say. */
function meets(p: Predicate, hit: SearchHit, matched: ReadonlySet<number>, numbers: Map<Predicate, number>): boolean | null {
    const node = hit.node
    const props = (node.properties ?? {}) as Record<string, unknown>
    switch (p.kind) {
        case 'entityType': {
            const has = p.values.some((v) => v.toLowerCase() === (node.entityType ?? '').toLowerCase())
            return (p.op ?? 'in') === 'in' ? has : !has
        }
        case 'tag': {
            const tags = new Set((node.tags ?? []).map((t) => t.toLowerCase()))
            const values = p.values.map((v) => v.toLowerCase())
            if (p.op === 'hasAll') return values.every((v) => tags.has(v))
            if (p.op === 'notHas') return !values.some((v) => tags.has(v))
            return values.some((v) => tags.has(v))
        }
        case 'hasProperty': {
            const has = props[p.key] !== undefined && props[p.key] !== null
            return p.negate ? !has : has
        }
        case 'text':
        case 'property':
            return numbers.has(p) && matched.has(numbers.get(p)!) ? true : null
        default:
            return null
    }
}


/** The listed lines of an any-of ``query`` that ``hit`` meets — their
 *  indices as the Sentence lists them (the subject first). Empty for an
 *  all-of query, or when the row can't say. */
export function whyItMatched(query: Predicate | null, hit: SearchHit): number[] {
    if (!query) return []
    const { subject, clauses, combine } = listedClauses(query)
    if (combine !== 'or' || clauses.length < 2) return []
    const numbers = leafNumbers(query)
    const matched = new Set(hit.matchedPredicates ?? [])
    const offset = subject ? 1 : 0
    return clauses.flatMap((c, i) => (meets(c.predicate, hit, matched, numbers) ? [offset + i] : []))
}
