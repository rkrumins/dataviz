/**
 * suggestFilters — turn what the user typed into ranked, ready-to-add
 * filter rows.
 *
 * The problem this solves: the panel used to open with a name-substring
 * box and nothing else, so reaching a property filter meant running a
 * text search, adding a filter, then deleting the text row. Every facet
 * the backend can query — tags, entity types, property keys, property
 * VALUES, layers, graph shape — was two or three non-obvious steps away.
 *
 * Here, one token is matched against all of them at once using the data
 * ``/search/discover`` already returns, so typing ``PII`` offers
 * ``tag is #PII``, ``classification = PII``, ``has property pii_flag``,
 * ``type is PII_Report`` and ``name contains "PII"`` together, and the
 * user picks the reading they meant.
 *
 * Pure and synchronous — no React, no store, no fetch. That's what makes
 * the ranking testable, which matters because ranking is the whole
 * product here: get the order wrong and the feature is noise.
 */
import type { Predicate } from '@/types/search'

import { isRowIncomplete } from '../ConditionRow'


export type SuggestionGroup =
    | 'text'
    | 'type'
    | 'tag'
    | 'propertyKey'
    | 'propertyValue'
    | 'layer'
    | 'structure'


export interface FilterSuggestion {
    /** Stable across renders — cmdk item value, React key, test hook. */
    id: string
    group: SuggestionGroup
    /** Lucide icon name, resolved through ``DynamicIcon``. */
    icon: string
    /** What the row will say, e.g. ``tag is #PII``. */
    title: string
    /** The part of ``title`` that matched, for highlight rendering. */
    match?: string
    /** Secondary line — where this came from, how sure we are. */
    hint?: string
    predicate: Predicate
    /** False when the predicate still needs a value from the user, so
     *  the caller can focus the new row's editor instead of just
     *  dropping it in. */
    complete: boolean
    score: number
}


export interface SuggestSection {
    group: SuggestionGroup | 'start'
    heading: string
    /** Rendered under the heading — used to say "these are samples". */
    note?: string
    items: FilterSuggestion[]
}


/** One sampled property value, pre-lowercased for matching. */
export interface ValueSample {
    key: string
    value: string
    lc: string
}


export interface SuggestInput {
    query: string
    entityTypes: ReadonlyArray<string>
    tagValues: ReadonlyArray<string>
    propertyKeys: ReadonlyArray<string>
    /** Flattened sampled values across every property key. */
    valueSamples: ReadonlyArray<ValueSample>
    layers: ReadonlyArray<{ value: string; label: string }>
    /** Narrow to a single facet — set by the browse tiles. */
    activeGroup?: SuggestionGroup | null
    /** Max items per section. */
    perGroup?: number
}


// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type MatchQuality = 'exact' | 'prefix' | 'word' | 'substring' | 'none'

const QUALITY_SCORE: Record<Exclude<MatchQuality, 'none'>, number> = {
    exact: 1000,
    prefix: 600,
    word: 450,
    substring: 250,
}

/**
 * Per-facet tie-break: what a bare token most plausibly means. A word
 * typed on its own is far more likely to be a tag or a type than a
 * substring of a name, so an exact tag outranks an exact-ish anything
 * else at equal match quality.
 */
const FACET_WEIGHT: Record<SuggestionGroup, number> = {
    tag: 60,
    type: 55,
    propertyValue: 50,
    propertyKey: 40,
    layer: 35,
    structure: 25,
    text: 20,
}


/**
 * Word boundaries include the separators real identifiers use plus
 * camelCase humps — without the hump rule, ``PII`` wouldn't
 * word-match ``hasPiiFlag`` and ``row`` wouldn't match ``maxRowCount``.
 */
function wordStarts(candidate: string): number[] {
    const starts = [0]
    for (let i = 1; i < candidate.length; i += 1) {
        const prev = candidate[i - 1]
        const cur = candidate[i]
        if (/[_\-.\s/:]/.test(prev)) starts.push(i)
        else if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) starts.push(i)
    }
    return starts
}


export function matchQuality(candidate: string, query: string): MatchQuality {
    if (!query) return 'none'
    const c = candidate.toLowerCase()
    const q = query.toLowerCase()
    if (c === q) return 'exact'
    if (c.startsWith(q)) return 'prefix'
    const at = c.indexOf(q)
    if (at < 0) return 'none'
    return wordStarts(candidate).includes(at) ? 'word' : 'substring'
}


function scoreFor(
    candidate: string, query: string, group: SuggestionGroup,
): number | null {
    const quality = matchQuality(candidate, query)
    if (quality === 'none') return null
    // Length penalty is what puts `#PII` above `#PII_Reviewed` when both
    // match: the closer the candidate is in length to what was typed,
    // the more likely it's the thing meant.
    const lengthPenalty = Math.min(15, Math.abs(candidate.length - query.length) / 2)
    return QUALITY_SCORE[quality] + FACET_WEIGHT[group] - lengthPenalty
}


// ---------------------------------------------------------------------------
// Predicate factories
// ---------------------------------------------------------------------------

function textPredicate(value: string, target: 'name' | 'description' | 'qualifiedName'): Predicate {
    return {
        kind: 'text', value, target,
        match: 'substring', caseSensitive: false, boost: 1,
    } as Predicate
}

const suggestion = (
    s: Omit<FilterSuggestion, 'complete'>,
): FilterSuggestion => ({ ...s, complete: !isRowIncomplete(s.predicate) })


/**
 * Filters that aren't derived from the data — graph shape and the
 * text targets. Kept deliberately short: this is the fast path, and
 * ``AddFilterPalette`` remains the full taxonomy behind "Browse all
 * filters". Anything added here must exist there too.
 */
const STRUCTURE_ENTRIES: ReadonlyArray<{
    keywords: string
    icon: string
    title: string
    hint: string
    predicate: Predicate
}> = [
    {
        keywords: 'no downstream dead end leaf terminal unused',
        icon: 'CircleArrowRight',
        title: 'Has no downstream lineage',
        hint: 'Dead ends — nothing reads from these',
        predicate: { kind: 'isLeaf', edgeClass: 'lineage' } as Predicate,
    },
    {
        keywords: 'no upstream source root origin',
        icon: 'CircleArrowLeft',
        title: 'Has no upstream lineage',
        hint: 'Sources — these are where data enters',
        predicate: { kind: 'isRoot', edgeClass: 'lineage' } as Predicate,
    },
    {
        keywords: 'orphan disconnected isolated no edges unlinked',
        icon: 'Unplug',
        title: 'Has no lineage at all',
        hint: 'Disconnected — neither upstream nor downstream',
        predicate: { kind: 'isOrphan', edgeClass: 'lineage' } as Predicate,
    },
    {
        keywords: 'has upstream incoming feeds from',
        icon: 'ArrowDownToLine',
        title: 'Has upstream lineage',
        hint: 'Something feeds these',
        predicate: { kind: 'hasIncoming', edgeClass: 'lineage' } as Predicate,
    },
    {
        keywords: 'has downstream outgoing feeds into consumers',
        icon: 'ArrowUpFromLine',
        title: 'Has downstream lineage',
        hint: 'These feed something else',
        predicate: { kind: 'hasOutgoing', edgeClass: 'lineage' } as Predicate,
    },
]


// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const DEFAULT_PER_GROUP = 4

const HEADINGS: Record<SuggestionGroup, string> = {
    text: 'Name & description',
    type: 'Entity type',
    tag: 'Tags',
    propertyValue: 'Property values',
    propertyKey: 'Properties',
    layer: 'Layers',
    structure: 'Lineage shape',
}


export function suggestFilters(input: SuggestInput): SuggestSection[] {
    const query = input.query.trim()
    const perGroup = input.perGroup ?? DEFAULT_PER_GROUP
    if (!query) return startHere(input, perGroup)

    const buckets = new Map<SuggestionGroup, FilterSuggestion[]>()
    const push = (group: SuggestionGroup, item: FilterSuggestion | null) => {
        if (!item) return
        const list = buckets.get(group) ?? []
        list.push(item)
        buckets.set(group, list)
    }

    for (const tag of input.tagValues) {
        const score = scoreFor(tag, query, 'tag')
        if (score === null) continue
        push('tag', suggestion({
            id: `tag:${tag}`, group: 'tag', icon: 'Tag', score,
            title: `Tagged #${tag}`, match: query,
            predicate: { kind: 'tag', op: 'hasAny', values: [tag] } as Predicate,
        }))
    }

    for (const type of input.entityTypes) {
        const score = scoreFor(type, query, 'type')
        if (score === null) continue
        push('type', suggestion({
            id: `type:${type}`, group: 'type', icon: 'Boxes', score,
            title: `Type is ${type}`, match: query,
            predicate: { kind: 'entityType', op: 'in', values: [type] } as Predicate,
        }))
    }

    // Value matches before key matches: someone typing a literal like
    // "PII" or "gold" almost always means the value, not a key named
    // after it. Capped per key so one key with twenty matching samples
    // can't crowd out every other facet.
    const perKey = new Map<string, number>()
    for (const sample of input.valueSamples) {
        const score = scoreFor(sample.value, query, 'propertyValue')
        if (score === null) continue
        const used = perKey.get(sample.key) ?? 0
        if (used >= 2) continue
        perKey.set(sample.key, used + 1)
        push('propertyValue', suggestion({
            id: `value:${sample.key}:${sample.value}`,
            group: 'propertyValue', icon: 'SlidersHorizontal', score,
            title: `${sample.key} is ${sample.value}`, match: query,
            hint: 'seen in this data source',
            predicate: {
                kind: 'property', key: sample.key, op: 'eq', value: sample.value,
            } as Predicate,
        }))
    }

    for (const key of input.propertyKeys) {
        const score = scoreFor(key, query, 'propertyKey')
        if (score === null) continue
        push('propertyKey', suggestion({
            id: `key:${key}`, group: 'propertyKey', icon: 'KeyRound', score,
            title: `Has a ${key} value`, match: query,
            predicate: { kind: 'hasProperty', key, negate: false } as Predicate,
        }))
        // The escape hatch from sampling: offer to compare this key
        // against the literal text typed, even when that exact value
        // never appeared in the sample. Samples are 20 values per key
        // — absence is not evidence, and gating on them would make the
        // omnibox confidently wrong.
        push('propertyKey', suggestion({
            id: `keyeq:${key}`, group: 'propertyKey', icon: 'Equal',
            score: score - 30,
            title: `${key} is "${query}"`,
            hint: 'use exactly what you typed',
            predicate: {
                kind: 'property', key, op: 'eq', value: query,
            } as Predicate,
        }))
    }

    for (const layer of input.layers) {
        const score = scoreFor(layer.label, query, 'layer')
        if (score === null) continue
        push('layer', suggestion({
            id: `layer:${layer.value}`, group: 'layer', icon: 'Layers', score,
            title: `In the ${layer.label} layer`, match: query,
            predicate: { kind: 'layer', layerAssignment: layer.value } as Predicate,
        }))
    }

    for (const entry of STRUCTURE_ENTRIES) {
        const score = scoreFor(entry.keywords, query, 'structure')
        if (score === null) continue
        push('structure', suggestion({
            id: `shape:${entry.title}`, group: 'structure', icon: entry.icon,
            // Keyword matches are a lookup aid, not a name match —
            // scoring them by the (long) keyword blob would rank
            // arbitrarily, so flatten to one tier.
            score: FACET_WEIGHT.structure + QUALITY_SCORE.substring,
            title: entry.title, hint: entry.hint, predicate: entry.predicate,
        }))
    }

    // Name-contains is the floor. It always appears, it's the only
    // suggestion that survives discovery being empty or erroring, and
    // it's exactly what the old quick-search box did — so the previous
    // behaviour is always one Enter away.
    push('text', suggestion({
        id: 'text:name', group: 'text', icon: 'Search',
        score: QUALITY_SCORE.exact + FACET_WEIGHT.text,
        title: `Name contains "${query}"`,
        predicate: textPredicate(query, 'name'),
    }))
    push('text', suggestion({
        id: 'text:description', group: 'text', icon: 'FileText',
        score: FACET_WEIGHT.text,
        title: `Description contains "${query}"`,
        predicate: textPredicate(query, 'description'),
    }))

    return assemble(buckets, input.activeGroup ?? null, perGroup)
}


/**
 * Order sections by their strongest hit rather than by a fixed list, so
 * the facet that actually matched what you typed leads. Ties fall back
 * to facet weight, which keeps the ordering stable for equal scores.
 */
function assemble(
    buckets: Map<SuggestionGroup, FilterSuggestion[]>,
    activeGroup: SuggestionGroup | null,
    perGroup: number,
): SuggestSection[] {
    const sections: SuggestSection[] = []
    for (const [group, items] of buckets) {
        if (activeGroup && group !== activeGroup) continue
        if (items.length === 0) continue
        items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        sections.push({
            group,
            heading: HEADINGS[group],
            note: group === 'propertyValue'
                ? 'Sampled from this data source — rarer values exist and can still be typed in'
                : undefined,
            items: items.slice(0, perGroup),
        })
    }
    sections.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0))
    return sections
}


/**
 * The empty-input state: a short, concrete "here's what's in your data"
 * list rather than an abstract menu. Everything shown is a real value
 * from this view, so a click is always a working query.
 */
function startHere(input: SuggestInput, perGroup: number): SuggestSection[] {
    if (input.activeGroup) {
        return assemble(browseBuckets(input, perGroup * 3), input.activeGroup, perGroup * 3)
    }
    const items: FilterSuggestion[] = []
    input.tagValues.slice(0, 2).forEach((tag, i) => {
        items.push(suggestion({
            id: `tag:${tag}`, group: 'tag', icon: 'Tag', score: 0,
            title: `Tagged #${tag}`,
            // Only the first — repeating "most used" on the runner-up
            // reads as a bug.
            hint: i === 0 ? 'most used tag in this view' : undefined,
            predicate: { kind: 'tag', op: 'hasAny', values: [tag] } as Predicate,
        }))
    })
    for (const type of input.entityTypes.slice(0, 2)) {
        items.push(suggestion({
            id: `type:${type}`, group: 'type', icon: 'Boxes', score: 0,
            title: `Everything of type ${type}`,
            predicate: { kind: 'entityType', op: 'in', values: [type] } as Predicate,
        }))
    }
    const key = input.propertyKeys[0]
    if (key) {
        items.push(suggestion({
            id: `key:${key}`, group: 'propertyKey', icon: 'KeyRound', score: 0,
            title: `Has a ${key} value`, hint: 'most common property in this view',
            predicate: { kind: 'hasProperty', key, negate: false } as Predicate,
        }))
    }
    items.push(suggestion({
        id: 'shape:isLeaf', group: 'structure', icon: 'CircleArrowRight', score: 0,
        title: 'Has no downstream lineage', hint: 'find dead ends',
        predicate: { kind: 'isLeaf', edgeClass: 'lineage' } as Predicate,
    }))
    if (items.length === 0) return []
    return [{
        group: 'start',
        heading: 'Start with something real',
        note: 'Built from this view\'s own data — every one of these returns results',
        items: items.slice(0, perGroup + 2),
    }]
}


/** Everything in one facet, unfiltered — what a browse tile shows. */
function browseBuckets(
    input: SuggestInput, limit: number,
): Map<SuggestionGroup, FilterSuggestion[]> {
    const buckets = new Map<SuggestionGroup, FilterSuggestion[]>()
    buckets.set('tag', input.tagValues.slice(0, limit).map((tag) => suggestion({
        id: `tag:${tag}`, group: 'tag', icon: 'Tag', score: 0,
        title: `Tagged #${tag}`,
        predicate: { kind: 'tag', op: 'hasAny', values: [tag] } as Predicate,
    })))
    buckets.set('type', input.entityTypes.slice(0, limit).map((type) => suggestion({
        id: `type:${type}`, group: 'type', icon: 'Boxes', score: 0,
        title: `Type is ${type}`,
        predicate: { kind: 'entityType', op: 'in', values: [type] } as Predicate,
    })))
    buckets.set('propertyKey', input.propertyKeys.slice(0, limit).map((key) => suggestion({
        id: `key:${key}`, group: 'propertyKey', icon: 'KeyRound', score: 0,
        title: `Has a ${key} value`,
        predicate: { kind: 'hasProperty', key, negate: false } as Predicate,
    })))
    buckets.set('layer', input.layers.slice(0, limit).map((layer) => suggestion({
        id: `layer:${layer.value}`, group: 'layer', icon: 'Layers', score: 0,
        title: `In the ${layer.label} layer`,
        predicate: { kind: 'layer', layerAssignment: layer.value } as Predicate,
    })))
    buckets.set('structure', STRUCTURE_ENTRIES.map((entry) => suggestion({
        id: `shape:${entry.title}`, group: 'structure', icon: entry.icon, score: 0,
        title: entry.title, hint: entry.hint, predicate: entry.predicate,
    })))
    buckets.set('text', [
        suggestion({
            id: 'text:name', group: 'text', icon: 'Search', score: 0,
            title: 'Name contains…', predicate: textPredicate('', 'name'),
        }),
        suggestion({
            id: 'text:description', group: 'text', icon: 'FileText', score: 0,
            title: 'Description contains…', predicate: textPredicate('', 'description'),
        }),
        suggestion({
            id: 'text:qualifiedName', group: 'text', icon: 'Link2', score: 0,
            title: 'Qualified name contains…',
            predicate: textPredicate('', 'qualifiedName'),
        }),
    ])
    for (const [group, items] of buckets) {
        if (items.length === 0) buckets.delete(group)
    }
    return buckets
}


/** The browse tiles, in display order. */
export const BROWSE_FACETS: ReadonlyArray<{
    group: SuggestionGroup; label: string; icon: string
}> = [
    { group: 'text', label: 'Name', icon: 'Search' },
    { group: 'type', label: 'Type', icon: 'Boxes' },
    { group: 'tag', label: 'Tags', icon: 'Tag' },
    { group: 'propertyKey', label: 'Properties', icon: 'KeyRound' },
    { group: 'layer', label: 'Layers', icon: 'Layers' },
    { group: 'structure', label: 'Lineage', icon: 'Waypoints' },
]
