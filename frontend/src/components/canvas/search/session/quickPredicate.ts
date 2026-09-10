/**
 * The quick query — what the canvas header search box holds — and the
 * two things it compiles to.
 *
 * A quick query is deliberately small: a word, where to look for it, how
 * to match it, and whether it is clamped to one container. Everything
 * richer (typed comparisons, OR groups, edge predicates) belongs to the
 * builder, which the user reaches through Refine. The two surfaces share
 * a wire format, so a quick query is compiled into the SAME predicate
 * shape the builder emits: one ``text`` leaf, optionally ANDed with the
 * ``descendantOf`` row that `setScopeCondition` produces. That is what
 * lets Refine open on the identical condition row instead of an empty
 * builder.
 *
 * "Type" is deliberately NOT a Look-in option: matching a word against
 * entity types produced confusing hits ("table" selecting every table),
 * and the results pane's type facets answer that question properly.
 */
import type { Predicate, TextPredicate, TextTarget } from '@/types/search'

import { setScopeCondition } from '../panel/predicateComposition'


/** Where a quick query looks. A string is a fixed field; an object is one
 *  user-property key (the header lists the view's keys from `useDiscovery`). */
export type QuickLookIn =
    | 'everything'
    | 'name'
    | 'description'
    | 'tags'
    | { property: string }

/** The four match modes the header offers, in wire spelling.
 *  (ConditionRow's labels: Contains · Starts with · Ends with · Is exactly.) */
export type QuickMatch = 'substring' | 'prefix' | 'suffix' | 'exact'

/** Whole view, or clamped to one container (the "inside ‹name› ×" chip). */
export type QuickScope = 'view' | { insideUrn: string; label: string }

export interface QuickQuery {
    text: string
    lookIn: QuickLookIn
    match: QuickMatch
    scope: QuickScope
}

export const DEFAULT_QUICK: QuickQuery = {
    text: '',
    lookIn: 'everything',
    match: 'substring',
    scope: 'view',
}

/**
 * The shortest text the debounced lane will dispatch.
 *
 * One letter matches most of a view: the request is expensive, the answer
 * is useless, and typing a word would pay for it once per keystroke.
 * Enter overrides this (see `buildQuickPredicate`'s ``minLength``) —
 * a deliberate run of a single character is the user asking for exactly
 * that, once.
 */
export const QUICK_MIN_LENGTH = 2


function targetFor(lookIn: QuickLookIn): TextTarget {
    if (typeof lookIn === 'object') return 'property'
    // 'everything' maps to the server's `any`, which spans name,
    // qualified name, description, tags and property values.
    return lookIn === 'everything' ? 'any' : lookIn
}


/**
 * Compile a quick query into the predicate to run, or null when there is
 * nothing worth running.
 *
 * @param minLength - the shortest text that produces a predicate. The
 *   debounced lane takes the default; Enter passes 1.
 */
export function buildQuickPredicate(
    q: QuickQuery,
    minLength: number = QUICK_MIN_LENGTH,
): Predicate | null {
    const value = q.text.trim()
    if (value.length < minLength) return null

    const leaf: TextPredicate = {
        kind: 'text',
        target: targetFor(q.lookIn),
        ...(typeof q.lookIn === 'object' ? { propertyKey: q.lookIn.property } : {}),
        value,
        match: q.match,
    }

    if (q.scope === 'view') return leaf

    // Same call the results pane makes when a group card is drilled into,
    // so the two produce one shape. 'any' is the FE-only hint that routes
    // ConditionRow to the any-node picker — a scoped container is usually
    // deeper than the view's top-level roots.
    return setScopeCondition(leaf, {
        kind: 'descendantOf',
        urns: [q.scope.insideUrn],
        uiScope: 'any',
    })
}


/**
 * The row box's local filter over children already on the canvas.
 *
 * Mirrors the operator semantics of the wire match modes so the rows that
 * survive locally are the rows the server would have returned — but only
 * over the display name, and always case-insensitively (the header box has
 * no case control). An empty query matches everything: the box is a filter,
 * and an empty filter hides nothing.
 *
 * A name is all this filter has. When the query is looking somewhere the
 * name cannot answer for — a description, a tag, a property value — it
 * abstains and passes the row: hiding a child the server WOULD return as a
 * hit is the worse of the two errors, and the server's own hits render
 * alongside these rows.
 */
export function matchesQuick(name: string, q: QuickQuery): boolean {
    if (q.lookIn !== 'everything' && q.lookIn !== 'name') return true
    const needle = q.text.trim().toLowerCase()
    if (needle.length === 0) return true
    const haystack = name.toLowerCase()
    switch (q.match) {
        case 'prefix': return haystack.startsWith(needle)
        case 'suffix': return haystack.endsWith(needle)
        case 'exact':  return haystack === needle
        default:       return haystack.includes(needle)
    }
}
