/**
 * compileFind — turn what a user typed in the Context View header into a
 * runnable ``Predicate``.
 *
 * One box serves two people, so this module has to serve both without
 * asking either to learn the other's habits:
 *
 *   - The business persona types words and picks from two controls: a
 *     match mode (contains / starts with / is exactly) and a field
 *     scope (everything / names & IDs / descriptions / tags). Those two
 *     choices ARE the query language; nothing else has to be learned.
 *   - The data analyst types ``revenue tag:PII rowCount > 1000`` and
 *     expects the operators to mean what they mean everywhere else in
 *     the product.
 *
 * Both land on the same predicate tree, so both get the same results,
 * the same canvas spotlight, and the same hand-off into Advanced Search.
 *
 * The whole implementation is ``parsePredicate`` (the DSL the Advanced
 * builder already speaks) plus one override: what a bareword compiles
 * to. Structured leaves — ``tag:``, ``type:``, ``desc:``, ``has:``,
 * comparisons, AND/OR/NOT, parens — are untouched, so an analyst's query
 * behaves identically whether it was typed here or in the builder.
 *
 * Pure: no React, no store, no network.
 */
import type { Predicate, TextMatchMode, TextTarget } from '@/types/search'

import { parsePredicate } from '../panel/predicateDsl'


/** How a typed word is matched. Maps 1:1 onto ``TextPredicate.match``;
 *  the backend's remaining modes (``suffix``/``fulltext``/``regex``) are
 *  either not enabled in v1 or not worth a control in a search box. */
export type FindMode = 'contains' | 'startsWith' | 'exact'

/** Which fields a typed word is matched against. */
export type FindScope = 'everything' | 'names' | 'descriptions' | 'tags'

export interface FindInput {
    text: string
    mode: FindMode
    scope: FindScope
}

export interface CompiledFind {
    /** ``null`` for empty input or a hard parse error. */
    predicate: Predicate | null
    /** Structured leaves the DSL recognised (``tag:PII``, ``rowCount > 1000``).
     *  Drives the "Reading this as" readback and the analyst affordances. */
    recognized: string[]
    /** Bareword runs that fell through to the mode/scope text predicate. */
    fallbackText: string[]
    /** True when the user typed at least one operator — the signal that
     *  they'd benefit from the filter builder rather than a plain box. */
    usedOperators: boolean
    /** Unbalanced parens, dangling operator, etc. Rendered inline; never
     *  thrown, because a half-typed query is the normal state of a search
     *  box and must not blow up the panel. */
    error?: string
}


const MODE_TO_MATCH: Record<FindMode, TextMatchMode> = {
    contains: 'substring',
    startsWith: 'prefix',
    exact: 'exact',
}


/** Human labels, colocated with the mapping so the UI and the compiler
 *  can never drift apart. */
export const FIND_MODE_LABELS: Record<FindMode, string> = {
    contains: 'Contains',
    startsWith: 'Starts with',
    exact: 'Is exactly',
}

export const FIND_SCOPE_LABELS: Record<FindScope, string> = {
    everything: 'Everything',
    names: 'Names',
    descriptions: 'Descriptions',
    tags: 'Tags',
}

export const FIND_SCOPE_HINTS: Record<FindScope, string> = {
    everything: 'Names, descriptions, tags, and property values',
    names: 'The entity name only',
    descriptions: 'The description field only',
    tags: 'Tags only',
}


function textPredicate(
    target: TextTarget,
    value: string,
    match: TextMatchMode,
): Predicate {
    return {
        kind: 'text',
        value,
        target,
        match,
        caseSensitive: false,
        boost: 1.0,
    }
}


/**
 * Build the predicate a plain typed word compiles to under the current
 * scope.
 *
 * ``everything`` ORs the denormalised full-text column with tags.
 * ``target: 'any'`` resolves server-side to ``n.searchableText``, which
 * is written from displayName + qualifiedName + description + every
 * STRING-valued user property — so property values are covered, but tags
 * are not (they live in their own column). One OR branch closes that gap
 * without a reindex, and substring-over-tags is what a keyword search
 * should do anyway: typing "pi" finds the tag "PII", which an exact
 * TagPredicate would miss.
 */
export function barewordPredicate(
    value: string,
    mode: FindMode,
    scope: FindScope,
): Predicate {
    const match = MODE_TO_MATCH[mode]
    switch (scope) {
        case 'names':
            // ``displayName``, not ``name``: the latter widens server-side
            // to displayName OR qualifiedName OR searchableText, and
            // searchableText carries descriptions and property values —
            // so a chip labelled "Names" backed by it would quietly
            // return description matches.
            return textPredicate('displayName', value, match)
        case 'descriptions':
            return textPredicate('description', value, match)
        case 'tags':
            return textPredicate('tags', value, match)
        case 'everything':
        default:
            return {
                kind: 'group',
                op: 'or',
                children: [
                    textPredicate('any', value, match),
                    textPredicate('tags', value, match),
                ],
            }
    }
}


/**
 * Compile a header query. Never throws — a malformed query returns
 * ``predicate: null`` with ``error`` set so the panel can say what is
 * wrong while the user is still typing it.
 */
export function compileFind({ text, mode, scope }: FindInput): CompiledFind {
    const trimmed = text.trim()
    if (!trimmed) {
        return {
            predicate: null,
            recognized: [],
            fallbackText: [],
            usedOperators: false,
        }
    }

    const parsed = parsePredicate(trimmed, {
        onBareword: (value) => barewordPredicate(value, mode, scope),
    })

    return {
        predicate: parsed.predicate,
        recognized: parsed.recognized,
        fallbackText: parsed.fallbackText,
        usedOperators: parsed.recognized.length > 0,
        ...(parsed.error ? { error: parsed.error } : {}),
    }
}
