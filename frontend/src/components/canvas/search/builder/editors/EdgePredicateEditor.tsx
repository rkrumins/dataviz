/**
 * EdgePredicateEditor — author ``edge_predicate`` filters that the
 * compiler attaches to ``PathPredicate`` and ``WithinHopsPredicate``
 * (W2.3 / UC3).
 *
 * Three predicate kinds:
 *
 *   EdgePropertyPredicate     filter on a single edge property value
 *                             (e.g. ``rel.confidence >= 0.8``)
 *   EdgeHasPropertyPredicate  edge has a given key set
 *                             (e.g. ``EXISTS(rel.confidence)``)
 *   EdgeGroupPredicate        AND / OR / NOT of edge predicates,
 *                             recursive to depth 3 (backend cap)
 *
 * The editor pulls edge-property keys + value samples from the
 * existing ``EditorContext`` (``ctx.keysByEdgeType`` and
 * ``ctx.getEdgeValueSamples``) so the user picks from a known set
 * rather than typing blind. Falls back to free-text when discovery
 * hasn't surfaced anything.
 *
 * Recursion is bounded:
 *   * Group depth is capped at ``MAX_EDGE_GROUP_DEPTH = 3``
 *     (matches the backend's ``MAX_TREE_DEPTH`` for the edge
 *     subtree).
 *   * Beyond the cap, the "+ Add nested group" affordance disables
 *     itself with a hint.
 */
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type {
    EdgeGroupPredicate,
    EdgeHasPropertyPredicate,
    EdgePredicateNode,
    EdgePropertyPredicate,
    PropertyOp,
} from '@/types/search'

import { FieldLabel, NumberField, SelectField, TextField } from './shared'
import { UnifiedPicker, type PickerOption } from './UnifiedPicker'

import type { EditorContext } from './index'


/** Backend caps the edge-predicate subtree depth at 3 (matches the
 *  top-level ``MAX_TREE_DEPTH`` divided by an intuition for what's
 *  practical to author). The editor mirrors that — nested groups
 *  beyond the cap can't be created from the UI. */
const MAX_EDGE_GROUP_DEPTH = 3


/** Per-edge property operators. Mirrors the top-level
 *  ``PROPERTY_OPS`` minus the ones that only make sense on node
 *  values (``contains`` / ``startsWith`` / ``endsWith`` on a
 *  confidence number is nonsensical — we surface them anyway,
 *  same as the node editor, but a future refinement could prune). */
const EDGE_PROPERTY_OPS: { value: PropertyOp; label: string }[] = [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'in', label: 'is one of' },
    { value: 'notIn', label: 'is not one of' },
    { value: 'contains', label: 'contains' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'between', label: 'between' },
]

type EdgeKind = NonNullable<EdgePredicateNode['kind']>
type EdgeGroupOp = NonNullable<EdgeGroupPredicate['op']>

const EDGE_KIND_OPTIONS: ReadonlyArray<{ value: EdgeKind; label: string }> = [
    { value: 'edgeProperty', label: 'edge property' },
    { value: 'edgeHasProperty', label: 'edge has property' },
    { value: 'edgeGroup', label: 'group (AND / OR / NOT)' },
]

const GROUP_OPS: ReadonlyArray<{ value: EdgeGroupOp; label: string }> = [
    { value: 'and', label: 'AND' },
    { value: 'or', label: 'OR' },
    { value: 'not', label: 'NOT' },
]


export interface EdgePredicateEditorProps {
    value: EdgePredicateNode | null
    onChange: (next: EdgePredicateNode | null) => void
    ctx: EditorContext
    /** Edge types the parent (PathEditor / WithinHopsEditor) narrowed
     *  to. When provided, the property-key picker shows the union of
     *  keys across those types; otherwise it shows all known edge keys. */
    edgeTypeHint?: ReadonlyArray<string>
    /** Depth of THIS editor in the recursive group tree. The dispatcher
     *  passes 0; ``EdgeGroupEditor`` increments for its children. Used
     *  to enforce ``MAX_EDGE_GROUP_DEPTH``. */
    depth?: number
}


export const EdgePredicateEditor: FC<EdgePredicateEditorProps> = ({
    value, onChange, ctx, edgeTypeHint, depth = 0,
}) => {
    // Empty slot — render a "+ Add edge filter" affordance that
    // initialises the most common shape (an EdgePropertyPredicate).
    if (value === null) {
        return (
            <button
                type="button"
                onClick={() => onChange({
                    kind: 'edgeProperty',
                    key: '',
                    op: 'eq',
                    value: '',
                })}
                className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
                    'border border-glass-border border-dashed',
                    'text-[11.5px] text-ink-muted',
                    'hover:text-ink hover:border-accent-lineage/40',
                    'transition-colors',
                )}
            >
                <Plus className="w-3 h-3" />
                Add edge filter
            </button>
        )
    }

    // Render based on kind. The kind-picker is shared at the top of
    // each branch — switching kinds replaces the whole node with a
    // fresh skeleton.
    return (
        <div className="flex flex-col gap-2 rounded-md border border-glass-border bg-canvas-base/40 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                    <FieldLabel>Edge filter kind</FieldLabel>
                    <SelectField
                        value={value.kind}
                        onChange={(nextKind) => {
                            // Replace the whole node with a fresh skeleton
                            // of the requested kind. We DON'T try to
                            // preserve fields across kinds (the shapes are
                            // too different) — the user clearly switched
                            // intent.
                            if (nextKind === value.kind) return
                            if (nextKind === 'edgeProperty') {
                                onChange({ kind: 'edgeProperty', key: '', op: 'eq', value: '' })
                            } else if (nextKind === 'edgeHasProperty') {
                                onChange({ kind: 'edgeHasProperty', key: '' })
                            } else if (nextKind === 'edgeGroup') {
                                onChange({ kind: 'edgeGroup', op: 'and', children: [] })
                            }
                        }}
                        options={EDGE_KIND_OPTIONS}
                    />
                </div>
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    title="Remove this edge filter"
                    className={cn(
                        'self-end mb-0.5 rounded p-1',
                        'text-ink-muted hover:text-rose-500 hover:bg-rose-500/10',
                        'transition-colors',
                    )}
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            {value.kind === 'edgeProperty' && (
                <EdgePropertyFields
                    value={value}
                    onChange={onChange as (next: EdgePropertyPredicate) => void}
                    ctx={ctx}
                    edgeTypeHint={edgeTypeHint}
                />
            )}
            {value.kind === 'edgeHasProperty' && (
                <EdgeHasPropertyFields
                    value={value}
                    onChange={onChange as (next: EdgeHasPropertyPredicate) => void}
                    ctx={ctx}
                    edgeTypeHint={edgeTypeHint}
                />
            )}
            {value.kind === 'edgeGroup' && (
                <EdgeGroupFields
                    value={value}
                    onChange={onChange as (next: EdgeGroupPredicate) => void}
                    ctx={ctx}
                    edgeTypeHint={edgeTypeHint}
                    depth={depth}
                />
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// EdgePropertyPredicate
// ---------------------------------------------------------------------------

function EdgePropertyFields({
    value, onChange, ctx, edgeTypeHint,
}: {
    value: EdgePropertyPredicate
    onChange: (next: EdgePropertyPredicate) => void
    ctx: EditorContext
    edgeTypeHint?: ReadonlyArray<string>
}) {
    const keyOptions = useMemo<PickerOption[]>(
        () => edgeKeyOptions(ctx, edgeTypeHint),
        [ctx, edgeTypeHint],
    )
    const valueSamples = useMemo<unknown[]>(() => {
        if (!value.key) return []
        // If the user narrowed to a single edge type, prefer its
        // samples; else union across known types.
        if (edgeTypeHint && edgeTypeHint.length === 1) {
            return ctx.getEdgeValueSamples(edgeTypeHint[0], value.key)
        }
        const union: unknown[] = []
        const seen = new Set<unknown>()
        for (const et of edgeTypeHint && edgeTypeHint.length > 0
            ? edgeTypeHint : ctx.edgeTypes) {
            for (const v of ctx.getEdgeValueSamples(et, value.key)) {
                if (!seen.has(v)) {
                    seen.add(v)
                    union.push(v)
                }
            }
        }
        return union
    }, [ctx, edgeTypeHint, value.key])

    const isMultiValue = value.op === 'in' || value.op === 'notIn'

    return (
        <div className="flex flex-col gap-2">
            <div>
                <FieldLabel>Edge property</FieldLabel>
                <UnifiedPicker
                    value={value.key}
                    onChange={(next) => onChange({ ...value, key: next as string })}
                    options={keyOptions}
                    placeholder={
                        keyOptions.length > 0
                            ? 'Pick a property key…'
                            : 'e.g. confidence'
                    }
                    allowFreeText
                />
            </div>
            <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1">
                    <FieldLabel>Operator</FieldLabel>
                    <SelectField
                        value={value.op}
                        onChange={(op) => onChange({ ...value, op })}
                        options={EDGE_PROPERTY_OPS}
                    />
                </div>
                <div className="col-span-2">
                    <FieldLabel>Value</FieldLabel>
                    {isMultiValue ? (
                        <UnifiedPicker
                            multiple
                            value={Array.isArray(value.value)
                                ? (value.value as unknown[]).map((v) => String(v))
                                : []}
                            onChange={(next: string[]) => onChange({
                                ...value,
                                value: next as unknown as EdgePropertyPredicate['value'],
                            })}
                            options={valueSamples.map<PickerOption>((v) => ({
                                value: String(v),
                                label: String(v),
                            }))}
                            placeholder="Pick or type values…"
                            allowFreeText
                        />
                    ) : valueSamples.length > 0 ? (
                        <UnifiedPicker
                            value={String(value.value ?? '')}
                            onChange={(next) => onChange({
                                ...value,
                                value: coerceValue(next as string),
                            })}
                            options={valueSamples.map<PickerOption>((v) => ({
                                value: String(v),
                                label: String(v),
                            }))}
                            placeholder="Pick or type a value…"
                            allowFreeText
                        />
                    ) : value.op === 'between' ? (
                        <BetweenEdgeValue
                            value={value.value}
                            onChange={(v) => onChange({ ...value, value: v })}
                        />
                    ) : (
                        <TextField
                            value={String(value.value ?? '')}
                            onChange={(next) => onChange({
                                ...value,
                                value: coerceValue(next),
                            })}
                            placeholder="e.g. 0.8 or manual"
                        />
                    )}
                </div>
            </div>
        </div>
    )
}


/** Two numeric inputs for the ``between`` operator on edge properties. */
function BetweenEdgeValue({
    value, onChange,
}: {
    value: EdgePropertyPredicate['value']
    onChange: (next: [number, number]) => void
}) {
    const [lo, hi] = Array.isArray(value) ? value as [unknown, unknown] : [0, 1]
    return (
        <div className="grid grid-cols-2 gap-1">
            <NumberField
                value={Number(lo) || 0}
                onChange={(v) => onChange([v, Number(hi) || 0])}
            />
            <NumberField
                value={Number(hi) || 0}
                onChange={(v) => onChange([Number(lo) || 0, v])}
            />
        </div>
    )
}


// ---------------------------------------------------------------------------
// EdgeHasPropertyPredicate
// ---------------------------------------------------------------------------

function EdgeHasPropertyFields({
    value, onChange, ctx, edgeTypeHint,
}: {
    value: EdgeHasPropertyPredicate
    onChange: (next: EdgeHasPropertyPredicate) => void
    ctx: EditorContext
    edgeTypeHint?: ReadonlyArray<string>
}) {
    const keyOptions = useMemo<PickerOption[]>(
        () => edgeKeyOptions(ctx, edgeTypeHint),
        [ctx, edgeTypeHint],
    )
    return (
        <div>
            <FieldLabel>Edge property exists</FieldLabel>
            <UnifiedPicker
                value={value.key}
                onChange={(next) => onChange({ ...value, key: next as string })}
                options={keyOptions}
                placeholder={
                    keyOptions.length > 0
                        ? 'Pick a property key…'
                        : 'e.g. discoveredBy'
                }
                allowFreeText
            />
        </div>
    )
}


// ---------------------------------------------------------------------------
// EdgeGroupPredicate (recursive)
// ---------------------------------------------------------------------------

function EdgeGroupFields({
    value, onChange, ctx, edgeTypeHint, depth,
}: {
    value: EdgeGroupPredicate
    onChange: (next: EdgeGroupPredicate) => void
    ctx: EditorContext
    edgeTypeHint?: ReadonlyArray<string>
    depth: number
}) {
    const atDepthLimit = depth >= MAX_EDGE_GROUP_DEPTH - 1
    const isNot = value.op === 'not'

    return (
        <div className="flex flex-col gap-2">
            <div>
                <FieldLabel>Group operator</FieldLabel>
                <SelectField
                    value={value.op}
                    onChange={(op) => {
                        // NOT requires exactly one child — trim if we
                        // had more (matches the backend validator).
                        if (op === 'not' && value.children.length > 1) {
                            onChange({
                                ...value,
                                op,
                                children: value.children.slice(0, 1),
                            })
                        } else {
                            onChange({ ...value, op })
                        }
                    }}
                    options={GROUP_OPS}
                />
            </div>
            <div className="flex flex-col gap-2 pl-2 border-l-2 border-glass-border/60">
                {value.children.map((child, i) => (
                    <div key={i} className="flex items-start gap-1">
                        <ChevronDown className="w-3.5 h-3.5 text-ink-muted/50 mt-3 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <EdgePredicateEditor
                                value={child}
                                onChange={(next) => {
                                    if (next === null) {
                                        // Drop the child.
                                        onChange({
                                            ...value,
                                            children: value.children.filter(
                                                (_, j) => j !== i,
                                            ),
                                        })
                                    } else {
                                        const nextChildren = [...value.children]
                                        nextChildren[i] = next
                                        onChange({
                                            ...value,
                                            children: nextChildren,
                                        })
                                    }
                                }}
                                ctx={ctx}
                                edgeTypeHint={edgeTypeHint}
                                depth={depth + 1}
                            />
                        </div>
                    </div>
                ))}
                {!isNot && (
                    <button
                        type="button"
                        disabled={atDepthLimit
                            && value.children.some((c) => c.kind === 'edgeGroup')}
                        onClick={() => onChange({
                            ...value,
                            children: [
                                ...value.children,
                                { kind: 'edgeProperty', key: '', op: 'eq', value: '' },
                            ],
                        })}
                        className={cn(
                            'self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md',
                            'border border-glass-border border-dashed',
                            'text-[11.5px] text-ink-muted',
                            'hover:text-ink hover:border-accent-lineage/40',
                            'transition-colors',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                        title={atDepthLimit
                            ? `Nesting capped at depth ${MAX_EDGE_GROUP_DEPTH}`
                            : 'Add another edge filter to this group'}
                    >
                        <Plus className="w-3 h-3" />
                        Add edge filter
                    </button>
                )}
                {isNot && value.children.length === 0 && (
                    <button
                        type="button"
                        onClick={() => onChange({
                            ...value,
                            children: [
                                { kind: 'edgeProperty', key: '', op: 'eq', value: '' },
                            ],
                        })}
                        className={cn(
                            'self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md',
                            'border border-glass-border border-dashed',
                            'text-[11.5px] text-ink-muted hover:text-ink',
                            'hover:border-accent-lineage/40',
                        )}
                    >
                        <Plus className="w-3 h-3" />
                        Set the NOT child
                    </button>
                )}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edgeKeyOptions(
    ctx: EditorContext,
    edgeTypeHint?: ReadonlyArray<string>,
): PickerOption[] {
    const set = new Set<string>()
    const types = edgeTypeHint && edgeTypeHint.length > 0
        ? edgeTypeHint
        : ctx.edgeTypes
    for (const et of types) {
        for (const key of ctx.keysByEdgeType[et] ?? []) {
            set.add(key)
        }
    }
    return Array.from(set).sort().map<PickerOption>((k) => ({ value: k }))
}


/** Coerce a free-text input into a typed JSON value when it parses as
 *  number / boolean / null. Otherwise return the raw string. Keeps the
 *  emitted predicate JSON canonical (``"0.8"`` becomes ``0.8``) so the
 *  schema-validated round-trip via predicateCodec stays lossless. */
function coerceValue(raw: string): EdgePropertyPredicate['value'] {
    const trimmed = raw.trim()
    if (trimmed === '') return ''
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    const asNumber = Number(trimmed)
    if (!Number.isNaN(asNumber) && /^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
        return asNumber
    }
    return trimmed
}
