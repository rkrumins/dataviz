/**
 * predicateComposition — pure helpers for the QueryCard's composable
 * filter-row model.
 *
 * Mental model: the draft predicate is normalised to a group at the
 * root (default AND), with children rendered as ConditionRow cards in
 * insertion order. Adding a filter APPENDS to the children; editing a
 * row REPLACES the child at that row's index. The user can have any
 * number of same-kind predicates (e.g. two TextPredicates: name
 * contains "t2" AND name contains "opp").
 *
 * Boolean-chip kinds (isOrphan / isLeaf / isRoot) are still treated as
 * toggles for a single-instance UX — toggling adds-or-removes the
 * unique-by-kind instance — so the user doesn't accidentally add two
 * "No upstream" rows.
 *
 * The store's draftPredicate remains the source of truth: every helper
 * returns a new Predicate tree (or null), and the caller pipes it
 * through ``runPredicate`` so the same publish pipeline fires as the
 * builder uses. JSON DSL stays in sync because both write to the same
 * draft.
 */
import type { Predicate, EdgeClass } from '@/types/search'


/**
 * Kinds that semantically behave like a toggle in the UI: at most one
 * instance ever exists in the root group, and clicking the chip again
 * removes it. Other kinds (text, property, tag, etc.) can repeat.
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


export type RootGroupOp = 'and' | 'or' | 'not'


/** Toggle-style kinds that must stay unique in the root group. */
const TOGGLE_KINDS: ReadonlySet<string> = new Set([
    'isOrphan', 'isLeaf', 'isRoot',
])


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


// ---------------------------------------------------------------------------
// Root normalisation
// ---------------------------------------------------------------------------

/**
 * Coerce any draft into an AND/OR-rooted group. Null becomes an empty
 * AND group; a single leaf becomes a one-child AND group; an existing
 * AND/OR group passes through (preserving its op). NOT roots are
 * wrapped in a one-child AND group — top-level NOT is rare and the
 * chip strip doesn't compose against it.
 */
function ensureRootGroup(draft: Predicate | null): {
    kind: 'group'; op: RootGroupOp; children: Predicate[]
} {
    if (!draft) return { kind: 'group', op: 'and', children: [] }
    if (draft.kind === 'group' && (draft.op === 'and' || draft.op === 'or')) {
        return { kind: 'group', op: draft.op, children: [...draft.children] }
    }
    return { kind: 'group', op: 'and', children: [draft] }
}


/**
 * Reverse of ``ensureRootGroup``: collapse a single-child group back to
 * its child, and an empty group back to ``null``. Preserves the
 * group's op for >1 child cases. Keeps the on-the-wire predicate as
 * small as possible so the explain/result diagnostics don't show a
 * redundant outer group.
 */
function collapseRoot(root: {
    kind: 'group'; op: RootGroupOp; children: Predicate[]
}): Predicate | null {
    if (root.children.length === 0) return null
    if (root.children.length === 1) return root.children[0]
    return root
}


// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Top-level children of the root group, in insertion order. */
export function topLevelConditions(draft: Predicate | null): Predicate[] {
    if (!draft) return []
    if (draft.kind === 'group' && (draft.op === 'and' || draft.op === 'or')) {
        return draft.children
    }
    return [draft]
}

/** Root operator (defaults to 'and' when there's no explicit group). */
export function rootGroupOp(draft: Predicate | null): RootGroupOp {
    if (draft && draft.kind === 'group') {
        if (draft.op === 'and' || draft.op === 'or' || draft.op === 'not') {
            return draft.op
        }
    }
    return 'and'
}

/** True when any condition of the given kind exists in the root group. */
export function isChipActive(draft: Predicate | null, kind: ChipConditionKind): boolean {
    return topLevelConditions(draft).some((c) => c.kind === kind)
}

/** Look up the first condition of the given kind (null if not active). */
export function findChipCondition(
    draft: Predicate | null,
    kind: ChipConditionKind,
): Predicate | null {
    return topLevelConditions(draft).find((c) => c.kind === kind) ?? null
}


// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Append a new condition to the root group. For toggle-style kinds
 * (isOrphan / isLeaf / isRoot), behaves like ``upsertCondition`` — the
 * same kind can't appear twice. For every other kind, the new condition
 * is appended; duplicates are allowed (two TextPredicates, etc.).
 */
export function appendCondition(
    draft: Predicate | null,
    next: Predicate,
): Predicate {
    const root = ensureRootGroup(draft)
    const nextKind = next.kind ?? ''
    if (TOGGLE_KINDS.has(nextKind)) {
        const idx = root.children.findIndex((c) => c.kind === nextKind)
        if (idx >= 0) {
            root.children[idx] = next
        } else {
            root.children.push(next)
        }
    } else {
        root.children.push(next)
    }
    return collapseRoot(root) ?? next
}

/**
 * Replace the child at ``index`` with the supplied predicate. Used by
 * row-level edits — the row already knows its index.
 *
 * If the index is out of bounds, falls back to ``appendCondition``.
 */
export function replaceConditionAt(
    draft: Predicate | null,
    index: number,
    next: Predicate,
): Predicate {
    const root = ensureRootGroup(draft)
    if (index < 0 || index >= root.children.length) {
        return appendCondition(draft, next)
    }
    root.children[index] = next
    return collapseRoot(root) ?? next
}

/**
 * Remove the child at ``index`` from the root group. Returns the new
 * tree or ``null`` if the group empties.
 */
export function removeConditionAt(
    draft: Predicate | null,
    index: number,
): Predicate | null {
    if (!draft) return null
    const root = ensureRootGroup(draft)
    if (index < 0 || index >= root.children.length) return draft
    root.children.splice(index, 1)
    return collapseRoot(root)
}

/**
 * Switch the root group's op. Now supports the full three-segment
 * AND / OR / NOT toggle:
 *
 *   - ``and`` / ``or`` — flip the root group's op (no-op when there's
 *     fewer than 2 children, since the op is irrelevant there).
 *   - ``not`` — wrap the entire current tree in a NOT group. When the
 *     tree is already a NOT group, unwrap to its child.
 */
export function setRootGroupOp(
    draft: Predicate | null,
    op: 'and' | 'or' | 'not',
): Predicate | null {
    if (op === 'not') {
        if (!draft) return null
        // Already a NOT root → unwrap.
        if (draft.kind === 'group' && draft.op === 'not' && draft.children.length === 1) {
            return draft.children[0]
        }
        return { kind: 'group', op: 'not', children: [draft] }
    }
    // Unwrapping out of a NOT root via ``and`` / ``or`` — drop the NOT
    // wrapper first so the user can pick the desired op.
    let inner: Predicate | null = draft
    if (draft && draft.kind === 'group' && draft.op === 'not') {
        inner = draft.children[0] ?? null
    }
    const root = ensureRootGroup(inner)
    if (root.children.length < 2) return inner
    root.op = op
    return collapseRoot(root)
}


/**
 * Wrap the child at ``index`` in a new group of the given op. The
 * new group becomes the child at the same position. Used by the
 * per-row "⋯ → Wrap in AND/OR/NOT group" action — the user builds
 * flat then iteratively groups what they want.
 */
export function wrapConditionAt(
    draft: Predicate | null,
    index: number,
    op: 'and' | 'or' | 'not',
): Predicate | null {
    if (!draft) return null
    const root = ensureRootGroup(draft)
    if (index < 0 || index >= root.children.length) return draft
    const target = root.children[index]
    root.children[index] = { kind: 'group', op, children: [target] }
    return collapseRoot(root)
}


/**
 * Insert a deep clone of the child at ``index`` immediately after it.
 * Used by the "⋯ → Duplicate" row action.
 */
export function duplicateConditionAt(
    draft: Predicate | null,
    index: number,
): Predicate | null {
    if (!draft) return null
    const root = ensureRootGroup(draft)
    if (index < 0 || index >= root.children.length) return draft
    const clone = structuredClone(root.children[index]) as Predicate
    root.children.splice(index + 1, 0, clone)
    return collapseRoot(root)
}

/**
 * Remove the first top-level condition of the given kind. Returns the
 * new predicate tree, or ``null`` if removal empties the group. Kept
 * for chip-style toggles — see ``toggleConditionKind``.
 */
export function removeConditionKind(
    draft: Predicate | null,
    kind: ChipConditionKind,
): Predicate | null {
    if (!draft) return null
    const root = ensureRootGroup(draft)
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
    return appendCondition(draft, {
        kind,
        edgeClass: DEFAULT_EDGE_CLASS,
    } as Predicate)
}

/**
 * @deprecated Replaced by ``appendCondition`` + ``replaceConditionAt``.
 * Old call sites that overwrote any same-kind predicate with the new
 * one — see git blame for the rationale. Kept as a thin wrapper for
 * external callers in case any remain.
 */
export function upsertCondition(
    draft: Predicate | null,
    next: Predicate,
): Predicate {
    return appendCondition(draft, next)
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
