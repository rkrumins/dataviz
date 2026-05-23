/**
 * predicateComposition — pure helpers for the AskBar's composable
 * filter-chip model.
 *
 * Mental model: the draft predicate is ALWAYS an AND group at the root,
 * with at most one condition of each "kind" as a child. Clicking a chip
 * upserts the corresponding condition; clicking the chip's × removes
 * it. OR / NOT composition lives in the Advanced builder — chips stay
 * AND-only so the active query reads top-to-bottom as a single filter.
 *
 * The store's draftPredicate remains the source of truth: every helper
 * returns a new Predicate tree (or null), and the caller pipes it
 * through ``runPredicate`` so the same publish pipeline fires as the
 * builder uses. JSON DSL stays in sync because both write to the same
 * draft.
 */
import type { Predicate, EdgeClass } from '@/types/search'


/**
 * Each composable chip maps to one of these kinds. Singletons in the
 * draft — adding the same kind twice REPLACES the prior condition.
 * Kinds that take parameters (entityType, tag, layer, property) are
 * still singletons here; multi-value cases are expressed inside the
 * single predicate (e.g. ``entityType in [dataset, schemaField]``).
 */
export type ChipConditionKind =
    | 'text'
    | 'entityType'
    | 'tag'
    | 'layer'
    | 'hasProperty'
    | 'property'
    | 'isOrphan'
    | 'isLeaf'
    | 'isRoot'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


// ---------------------------------------------------------------------------
// Root normalisation
// ---------------------------------------------------------------------------

/**
 * Coerce any draft into an AND-rooted group. Null becomes an empty
 * AND group; a single leaf becomes a one-child AND group; an existing
 * AND group passes through. OR / NOT roots (only built by the
 * Advanced builder) are wrapped in a one-child AND group so chip
 * composition continues to work — they appear as a single "composite"
 * condition the user can't toggle off via chips (they'd have to open
 * Advanced to edit).
 */
function ensureAndRoot(draft: Predicate | null): {
    kind: 'group'; op: 'and'; children: Predicate[]
} {
    if (!draft) return { kind: 'group', op: 'and', children: [] }
    if (draft.kind === 'group' && draft.op === 'and') {
        return { kind: 'group', op: 'and', children: [...draft.children] }
    }
    return { kind: 'group', op: 'and', children: [draft] }
}


/**
 * Reverse of ``ensureAndRoot``: collapse a single-child AND back to
 * its child, and an empty AND back to ``null``. Keeps the on-the-wire
 * predicate as small as possible so the explain/result diagnostics
 * don't show a redundant outer group.
 */
function collapseRoot(root: {
    kind: 'group'; op: 'and'; children: Predicate[]
}): Predicate | null {
    if (root.children.length === 0) return null
    if (root.children.length === 1) return root.children[0]
    return root
}


// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Top-level children of the AND root, in insertion order. */
export function topLevelConditions(draft: Predicate | null): Predicate[] {
    if (!draft) return []
    if (draft.kind === 'group' && draft.op === 'and') return draft.children
    return [draft]
}

/** True when a chip of the given kind is currently active in the draft. */
export function isChipActive(draft: Predicate | null, kind: ChipConditionKind): boolean {
    return topLevelConditions(draft).some((c) => c.kind === kind)
}

/** Look up the current value of a chip's condition (null if not active). */
export function findChipCondition(
    draft: Predicate | null,
    kind: ChipConditionKind,
): Predicate | null {
    return topLevelConditions(draft).find((c) => c.kind === kind) ?? null
}


// ---------------------------------------------------------------------------
// Upsert / remove
// ---------------------------------------------------------------------------

/**
 * Insert or replace the condition with the given kind. Returns the new
 * predicate tree (or the same identity if no change).
 */
export function upsertCondition(
    draft: Predicate | null,
    next: Predicate,
): Predicate {
    const root = ensureAndRoot(draft)
    const idx = root.children.findIndex((c) => c.kind === next.kind)
    if (idx >= 0) {
        root.children[idx] = next
    } else {
        root.children.push(next)
    }
    return collapseRoot(root) ?? next
}

/**
 * Remove the first top-level condition of the given kind. Returns the
 * new predicate tree, or ``null`` if removal empties the AND group.
 */
export function removeConditionKind(
    draft: Predicate | null,
    kind: ChipConditionKind,
): Predicate | null {
    if (!draft) return null
    const root = ensureAndRoot(draft)
    const idx = root.children.findIndex((c) => c.kind === kind)
    if (idx < 0) return draft
    root.children.splice(idx, 1)
    return collapseRoot(root)
}

/**
 * Toggle a graph-shape / boolean condition (no parameters needed) on
 * or off. Used by the no-upstream / no-downstream / no-lineage chips.
 */
export function toggleConditionKind(
    draft: Predicate | null,
    kind: 'isOrphan' | 'isLeaf' | 'isRoot',
): Predicate | null {
    if (isChipActive(draft, kind)) {
        return removeConditionKind(draft, kind)
    }
    return upsertCondition(draft, {
        kind,
        edgeClass: DEFAULT_EDGE_CLASS,
    } as Predicate)
}


// ---------------------------------------------------------------------------
// Factory helpers for parameterised conditions
// ---------------------------------------------------------------------------

/**
 * Substring text condition across name + qualifiedName + description.
 * We bake the OR over the three text targets so the chip composes
 * cleanly as a single "kind=group" entry — except chip composition
 * keys on the OUTER child's kind, not the inner OR. To keep the
 * single-text-chip invariant we tag the OR group with a marker kind
 * the chip code knows about… actually simpler: just store a single
 * TextPredicate against target='name' and document the limitation.
 * Power users go to Advanced for cross-field substring.
 *
 * Returning ``null`` for an empty / whitespace-only value lets the
 * caller remove the chip in one step.
 */
export function makeTextCondition(value: string): Predicate | null {
    const v = value.trim()
    if (!v) return null
    return {
        kind: 'text',
        value: v,
        target: 'name',
        match: 'substring',
        caseSensitive: false,
        boost: 1.0,
    }
}

export function makeEntityTypeCondition(values: string[]): Predicate | null {
    const v = values.filter(Boolean)
    if (v.length === 0) return null
    return { kind: 'entityType', op: 'in', values: v }
}

export function makeTagCondition(values: string[]): Predicate | null {
    const v = values.filter(Boolean)
    if (v.length === 0) return null
    return { kind: 'tag', op: 'hasAny', values: v }
}

export function makeLayerCondition(layer: string): Predicate | null {
    const v = layer.trim()
    if (!v) return null
    return { kind: 'layer', layerAssignment: v }
}

export function makeHasPropertyCondition(key: string): Predicate | null {
    const v = key.trim()
    if (!v) return null
    return { kind: 'hasProperty', key: v, negate: false }
}


// ---------------------------------------------------------------------------
// Active-condition serialisation for the active-query chip strip
// ---------------------------------------------------------------------------

/** One renderable item for the active-query chip strip. */
export interface ActiveConditionChip {
    kind: ChipConditionKind | string  // string for composite/unknown
    label: string
    /** True for kinds the chip strip can edit directly (vs Advanced). */
    canEditInline: boolean
}


export function describeActiveConditions(draft: Predicate | null): ActiveConditionChip[] {
    return topLevelConditions(draft).map((c) => describeCondition(c))
}


function describeCondition(p: Predicate): ActiveConditionChip {
    switch (p.kind) {
        case 'text':
            return {
                kind: 'text',
                label: `"${p.value}" in ${p.target ?? 'name'}`,
                canEditInline: true,
            }
        case 'entityType':
            return {
                kind: 'entityType',
                label: `Type ${p.op === 'notIn' ? '∉' : 'is'} ${p.values.join(' / ')}`,
                canEditInline: true,
            }
        case 'tag':
            return {
                kind: 'tag',
                label: `Tag${p.values.length > 1 ? 's' : ''}: ${p.values.map((v) => `#${v}`).join(', ')}`,
                canEditInline: true,
            }
        case 'layer':
            return {
                kind: 'layer',
                label: `Layer: ${p.layerAssignment}`,
                canEditInline: true,
            }
        case 'hasProperty':
            return {
                kind: 'hasProperty',
                label: p.negate ? `no ${p.key}` : `has ${p.key}`,
                canEditInline: true,
            }
        case 'property':
            return {
                kind: 'property',
                label: `${p.key} ${p.op ?? '='} ${formatValue(p.value)}`,
                canEditInline: false,
            }
        case 'isOrphan':
            return { kind: 'isOrphan', label: 'No lineage', canEditInline: true }
        case 'isLeaf':
            return { kind: 'isLeaf', label: 'No downstream', canEditInline: true }
        case 'isRoot':
            return { kind: 'isRoot', label: 'No upstream', canEditInline: true }
        case 'group':
            return {
                kind: 'group',
                label: `${(p.op ?? 'and').toUpperCase()} group · ${p.children.length} conditions`,
                canEditInline: false,
            }
        default:
            return {
                kind: (p as { kind?: string }).kind ?? 'unknown',
                label: (p as { kind?: string }).kind ?? 'unknown',
                canEditInline: false,
            }
    }
}


function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '∅'
    if (Array.isArray(v)) return `[${v.length}]`
    if (typeof v === 'string') return v.length > 16 ? `"${v.slice(0, 16)}…"` : `"${v}"`
    return String(v)
}
