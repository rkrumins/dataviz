/**
 * Leaf-predicate editors, one per `kind` in the predicate type union.
 *
 * Each editor is a pure controlled component:
 *   props: { value, onChange, ctx }
 *   - value: the predicate (typed by kind)
 *   - onChange(next): emit a replacement of the same kind
 *   - ctx: panel-wide context — discovery for autocomplete, known
 *     entity types, etc.
 *
 * The dispatcher `LeafEditor` picks the right one based on `value.kind`
 * (TypeScript narrows the union for each branch). Adding a new leaf
 * kind:
 *   1. Define the predicate type in `@/types/search`.
 *   2. Add a `LeafKindMeta` entry in `../leafKinds.ts`.
 *   3. Add a case here.
 *
 * Sugar predicates (isOrphan/isLeaf/isRoot/hasIncoming/hasOutgoing) all
 * share the same shape — a single `EdgeClassEditor` handles all five.
 */
import type {
    Predicate,
    PropertyPredicate,
    PropertyOp,
    HasPropertyPredicate,
    TagPredicate,
    EntityTypePredicate,
    LayerPredicate,
    TextPredicate,
    TextTarget,
    TextMatchMode,
    DegreePredicate,
    DegreeOp,
    DegreeDirection,
    EdgeClass,
    IsOrphanPredicate,
    IsLeafPredicate,
    IsRootPredicate,
    HasIncomingPredicate,
    HasOutgoingPredicate,
    DescendantOfPredicate,
    WithinHopsPredicate,
    PathPredicate,
    PathDirection,
} from '@/types/search'

import { cn } from '@/lib/utils'

import {
    FieldLabel,
    TextField,
    NumberField,
    SelectField,
    ChipInput,
    fieldClass,
} from './shared'
import { UnifiedPicker, type PickerOption } from './UnifiedPicker'


// ---------------------------------------------------------------------------
// Shared context — what every editor may consume
// ---------------------------------------------------------------------------

export interface EditorContext {
    /** Native property keys present per entity-type label (from /search/discover).
     *  Empty object before the first discovery response settles. */
    keysByEntityType: Record<string, string[]>
    /** Union of all native property keys across labels. */
    allKeys: string[]
    /** Entity types known to the active view. */
    knownEntityTypes: string[]
    /** Layers configured in the active view (if available). */
    knownLayers: string[]
    /** Tag values surfaced by /search/discover, ordered by descending
     *  count. Powers the tag picker. */
    tagValues: string[]
    /** Look up sample values for a property key. Returns ``[]`` when
     *  discovery hasn't surfaced any. */
    getValueSamples: (propertyKey: string) => unknown[]
    /** Edge types present in the sample. */
    edgeTypes: string[]
    /** Property keys per edge type. */
    keysByEdgeType: Record<string, string[]>
    /** Look up sample values for an edge property key. */
    getEdgeValueSamples: (edgeType: string, propertyKey: string) => unknown[]
}


type EditorProps<P extends Predicate> = {
    value: P
    onChange: (next: P) => void
    ctx: EditorContext
}


// ---------------------------------------------------------------------------
// Option catalogs
// ---------------------------------------------------------------------------

const PROPERTY_OPS: { value: PropertyOp; label: string }[] = [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'contains', label: 'contains' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'in', label: 'is one of' },
    { value: 'notIn', label: 'is not one of' },
    { value: 'between', label: 'between' },
]

const TAG_OPS: { value: NonNullable<TagPredicate['op']>; label: string }[] = [
    { value: 'has', label: 'has any of' },
    { value: 'hasAll', label: 'has all of' },
    { value: 'hasAny', label: 'has any of (synonym)' },
    { value: 'notHas', label: 'has none of' },
]

const TEXT_TARGETS: { value: TextTarget; label: string }[] = [
    { value: 'any', label: 'any field' },
    { value: 'name', label: 'display name' },
    { value: 'qualifiedName', label: 'qualified name' },
    { value: 'description', label: 'description' },
    { value: 'tags', label: 'tags' },
    { value: 'property', label: 'a property value' },
]

const TEXT_MATCH: { value: TextMatchMode; label: string; disabledFor?: TextTarget[] }[] = [
    { value: 'substring', label: 'contains' },
    { value: 'exact', label: 'equals' },
    { value: 'prefix', label: 'starts with' },
    // ``target='any'`` + ``fulltext`` is the only deferred combo. Other
    // targets allow fulltext mode through compile (it's behind a feature
    // flag downstream but the UI accepts it).
    { value: 'fulltext', label: 'fulltext (not yet enabled)', disabledFor: ['any'] },
    { value: 'regex', label: 'regex (gated)' },
]

const DEGREE_OPS: { value: DegreeOp; label: string }[] = [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
]

const DEGREE_DIRECTION: { value: DegreeDirection; label: string }[] = [
    { value: 'in', label: 'incoming' },
    { value: 'out', label: 'outgoing' },
    { value: 'both', label: 'incoming + outgoing' },
]

const EDGE_CLASS: { value: EdgeClass; label: string }[] = [
    { value: 'lineage', label: 'lineage' },
    { value: 'containment', label: 'containment' },
    { value: 'any', label: 'any edge' },
]

const ENTITY_TYPE_OP: { value: NonNullable<EntityTypePredicate['op']>; label: string }[] = [
    { value: 'in', label: 'is one of' },
    { value: 'notIn', label: 'is not one of' },
]

const HOP_DIRECTION: { value: NonNullable<WithinHopsPredicate['direction']>; label: string }[] = [
    { value: 'out', label: 'downstream' },
    { value: 'in', label: 'upstream' },
    { value: 'both', label: 'either direction' },
]

const PATH_DIRECTION: { value: PathDirection; label: string }[] = [
    { value: 'outgoing', label: 'source → target (downstream)' },
    { value: 'incoming', label: 'source ← target (upstream)' },
    { value: 'any', label: 'either direction' },
]


// ---------------------------------------------------------------------------
// Individual editors
// ---------------------------------------------------------------------------

function PropertyEditor({ value, onChange, ctx }: EditorProps<PropertyPredicate>) {
    const op: PropertyOp = value.op ?? 'eq'

    // Discovery-driven value suggestions for the selected property key.
    // The picker still allows free text (the user can type any value),
    // but when discovery knows the value space we surface it as the
    // primary affordance.
    const valueSamples = value.key ? ctx.getValueSamples(value.key) : []
    const sampleStrings = valueSamples
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .filter((s) => s.length > 0)

    // Operators that produce a list of values (e.g. ``in``, ``notIn``)
    // get a multi-select UnifiedPicker. ``between`` keeps the legacy
    // ``lo,hi`` text input — formalising it deserves its own UI pass.
    const isMultiValueOp = op === 'in' || op === 'notIn'

    const currentValueArray = Array.isArray(value.value)
        ? value.value.map((v) => (typeof v === 'string' ? v : String(v)))
        : []
    const valueStr = value.value === null || value.value === undefined
        ? ''
        : String(value.value)

    return (
        <div className="grid grid-cols-[2fr_auto_3fr] gap-2 items-end">
            <div>
                <FieldLabel>Property</FieldLabel>
                <UnifiedPicker
                    value={value.key}
                    onChange={(k) => onChange({ ...value, key: k })}
                    options={ctx.allKeys.map<PickerOption>((k) => ({ value: k }))}
                    placeholder="e.g. layer, dataType, pii_class"
                    emptyHint="Loading property keys…"
                    mono
                />
            </div>
            <div className="min-w-[7rem]">
                <FieldLabel>Op</FieldLabel>
                <SelectField
                    value={op}
                    onChange={(next) => onChange({ ...value, op: next })}
                    options={PROPERTY_OPS}
                />
            </div>
            <div>
                <FieldLabel>Value</FieldLabel>
                {isMultiValueOp ? (
                    <UnifiedPicker
                        multiple
                        value={currentValueArray}
                        onChange={(values) => onChange({ ...value, value: values })}
                        options={sampleStrings.map<PickerOption>((s) => ({ value: s }))}
                        placeholder={
                            sampleStrings.length > 0
                                ? 'Pick from known values'
                                : 'Type a value, then Enter'
                        }
                        emptyHint={
                            value.key
                                ? `No discovered values for ${value.key} — type a value.`
                                : 'Pick a property first.'
                        }
                        mono
                    />
                ) : op === 'between' ? (
                    <BetweenField
                        value={value.value}
                        onChange={(next) => onChange({ ...value, value: next })}
                    />
                ) : sampleStrings.length > 0 ? (
                    <UnifiedPicker
                        value={valueStr}
                        onChange={(v) => onChange({ ...value, value: v })}
                        options={sampleStrings.map<PickerOption>((s) => ({ value: s }))}
                        placeholder="Pick or type a value"
                        emptyHint={
                            value.key
                                ? `No discovered values for ${value.key}.`
                                : 'Pick a property first.'
                        }
                        mono
                    />
                ) : (
                    <TextField
                        value={valueStr}
                        onChange={(v) => onChange({ ...value, value: v })}
                        placeholder={value.key ? 'Type a value' : 'Pick a property first'}
                        mono
                    />
                )}
            </div>
        </div>
    )
}


function HasPropertyEditor({ value, onChange, ctx }: EditorProps<HasPropertyPredicate>) {
    return (
        <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div>
                <FieldLabel>Property key</FieldLabel>
                <UnifiedPicker
                    value={value.key}
                    onChange={(k) => onChange({ ...value, key: k })}
                    options={ctx.allKeys.map<PickerOption>((k) => ({ value: k }))}
                    placeholder="e.g. pii_class, owner"
                    emptyHint="Loading property keys…"
                    mono
                />
            </div>
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-elevated/60 border border-glass-border cursor-pointer">
                <input
                    type="checkbox"
                    checked={value.negate}
                    onChange={(e) => onChange({ ...value, negate: e.target.checked })}
                    className="accent-accent-lineage"
                />
                <span className="text-xs text-ink whitespace-nowrap">does not have</span>
            </label>
        </div>
    )
}


function TagEditor({ value, onChange, ctx }: EditorProps<TagPredicate>) {
    const op: TagPredicate['op'] = value.op ?? 'has'
    return (
        <div className="grid grid-cols-[auto_1fr] gap-2 items-end">
            <div className="min-w-[10rem]">
                <FieldLabel>Match</FieldLabel>
                <SelectField
                    value={op as NonNullable<TagPredicate['op']>}
                    onChange={(next) => onChange({ ...value, op: next })}
                    options={TAG_OPS}
                />
            </div>
            <div>
                <FieldLabel>Tags</FieldLabel>
                <UnifiedPicker
                    multiple
                    value={value.values}
                    onChange={(values) => onChange({ ...value, values })}
                    options={ctx.tagValues.map<PickerOption>((t) => ({ value: t }))}
                    placeholder={
                        ctx.tagValues.length > 0
                            ? 'Pick from known tags or type a new one'
                            : 'Type a tag, then Enter'
                    }
                    emptyHint="No tags discovered yet — type one and press Enter."
                    allowFreeText
                />
            </div>
        </div>
    )
}


function EntityTypeEditor({ value, onChange, ctx }: EditorProps<EntityTypePredicate>) {
    const op: NonNullable<EntityTypePredicate['op']> = value.op ?? 'in'
    return (
        <div className="grid grid-cols-[auto_1fr] gap-2 items-end">
            <div className="min-w-[10rem]">
                <FieldLabel>Match</FieldLabel>
                <SelectField
                    value={op}
                    onChange={(next) => onChange({ ...value, op: next })}
                    options={ENTITY_TYPE_OP}
                />
            </div>
            <div>
                <FieldLabel>Entity types</FieldLabel>
                <UnifiedPicker
                    multiple
                    value={value.values}
                    onChange={(values) => onChange({ ...value, values })}
                    options={ctx.knownEntityTypes.map<PickerOption>((t) => ({
                        value: t,
                    }))}
                    placeholder={
                        ctx.knownEntityTypes.length > 0
                            ? 'Pick one or more entity types'
                            : 'e.g. dataset, schemaField'
                    }
                    emptyHint="No entity types discovered yet."
                />
            </div>
        </div>
    )
}


function LayerEditor({ value, onChange, ctx }: EditorProps<LayerPredicate>) {
    return (
        <div>
            <FieldLabel>Layer</FieldLabel>
            <UnifiedPicker
                value={value.layerAssignment}
                onChange={(la) => onChange({ ...value, layerAssignment: la })}
                options={ctx.knownLayers.map<PickerOption>((l) => ({ value: l }))}
                placeholder={
                    ctx.knownLayers.length > 0
                        ? 'Pick a layer'
                        : 'e.g. Source, Staging, Refinery, Report'
                }
                emptyHint="No layers configured for this view."
            />
        </div>
    )
}


function TextEditor({ value, onChange, ctx }: EditorProps<TextPredicate>) {
    const target: TextTarget = value.target ?? 'any'
    const match: TextMatchMode = value.match ?? 'substring'
    // Surface invalid combinations as disabled options in the dropdown
    // instead of letting the user build a query that fails at compile.
    const filteredMatchOptions = TEXT_MATCH.map((m) => ({
        value: m.value,
        label: m.label,
        disabled: m.disabledFor?.includes(target),
    }))
    // If the user previously picked an invalid combo (e.g. switched from
    // a target that allowed `fulltext` to `any` which doesn't), coerce
    // back to a valid default the next render.
    const effectiveMatch: TextMatchMode =
        TEXT_MATCH.find((m) => m.value === match)?.disabledFor?.includes(target)
            ? 'substring'
            : match
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <FieldLabel>Field</FieldLabel>
                    <SelectField
                        value={target}
                        onChange={(next) => {
                            // Switching to a target that disallows the
                            // current match mode → reset to substring.
                            const disallowed = TEXT_MATCH.find((m) => m.value === match)?.disabledFor?.includes(next)
                            onChange({
                                ...value,
                                target: next,
                                ...(disallowed ? { match: 'substring' as TextMatchMode } : {}),
                            })
                        }}
                        options={TEXT_TARGETS}
                    />
                </div>
                <div>
                    <FieldLabel>Match</FieldLabel>
                    <SelectField
                        value={effectiveMatch}
                        onChange={(next) => onChange({ ...value, match: next })}
                        options={filteredMatchOptions}
                    />
                </div>
            </div>
            {target === 'property' && (
                <div>
                    <FieldLabel>Property key</FieldLabel>
                    <UnifiedPicker
                        value={value.propertyKey ?? ''}
                        onChange={(k) => onChange({ ...value, propertyKey: k })}
                        options={ctx.allKeys.map<PickerOption>((k) => ({ value: k }))}
                        placeholder="e.g. owner, transformLogic"
                        emptyHint="Loading property keys…"
                        mono
                    />
                </div>
            )}
            <div>
                <FieldLabel>Text</FieldLabel>
                <TextField
                    value={value.value}
                    onChange={(v) => onChange({ ...value, value: v })}
                    placeholder="search text"
                />
            </div>
        </div>
    )
}


function DegreeEditor({ value, onChange }: EditorProps<DegreePredicate>) {
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2">
                <div>
                    <FieldLabel>Direction</FieldLabel>
                    <SelectField
                        value={value.direction}
                        onChange={(direction) => onChange({ ...value, direction })}
                        options={DEGREE_DIRECTION}
                    />
                </div>
                <div>
                    <FieldLabel>Op</FieldLabel>
                    <SelectField
                        value={value.op}
                        onChange={(op) => onChange({ ...value, op })}
                        options={DEGREE_OPS}
                    />
                </div>
                <div>
                    <FieldLabel>Count</FieldLabel>
                    <NumberField
                        value={value.value}
                        onChange={(v) => onChange({ ...value, value: v })}
                        min={0}
                    />
                </div>
            </div>
            <div className="grid grid-cols-[1fr_2fr] gap-2">
                <div>
                    <FieldLabel>Edge class</FieldLabel>
                    <SelectField
                        value={value.edgeClass}
                        onChange={(ec) => onChange({ ...value, edgeClass: ec })}
                        options={EDGE_CLASS}
                    />
                </div>
                <div>
                    <FieldLabel>Edge types (optional, overrides class)</FieldLabel>
                    <ChipInput
                        values={value.edgeTypes ?? []}
                        onChange={(types) => onChange({
                            ...value,
                            edgeTypes: types.length > 0 ? types : undefined,
                        })}
                        placeholder="e.g. LINEAGE"
                    />
                </div>
            </div>
        </div>
    )
}


type SugarPredicate =
    | IsOrphanPredicate | IsLeafPredicate | IsRootPredicate
    | HasIncomingPredicate | HasOutgoingPredicate

function SugarEdgeClassEditor({ value, onChange }: EditorProps<SugarPredicate>) {
    return (
        <div className="grid grid-cols-[1fr_2fr] gap-2">
            <div>
                <FieldLabel>Edge class</FieldLabel>
                <SelectField
                    value={value.edgeClass}
                    onChange={(ec) => onChange({ ...value, edgeClass: ec })}
                    options={EDGE_CLASS}
                />
            </div>
            <div>
                <FieldLabel>Edge types (optional)</FieldLabel>
                <ChipInput
                    values={value.edgeTypes ?? []}
                    onChange={(types) => onChange({
                        ...value,
                        edgeTypes: types.length > 0 ? types : undefined,
                    })}
                    placeholder="e.g. LINEAGE"
                />
            </div>
        </div>
    )
}


function DescendantOfEditor({ value, onChange }: EditorProps<DescendantOfPredicate>) {
    return (
        <div className="flex flex-col gap-2">
            <div>
                <FieldLabel>Ancestor URNs</FieldLabel>
                <ChipInput
                    values={value.urns}
                    onChange={(urns) => onChange({ ...value, urns })}
                    placeholder="urn:li:dataset:foo"
                />
            </div>
            <div>
                <FieldLabel>Max depth (optional)</FieldLabel>
                <NumberField
                    value={value.maxDepth ?? 0}
                    onChange={(v) => onChange({ ...value, maxDepth: v > 0 ? v : undefined })}
                    min={0}
                    max={20}
                />
            </div>
        </div>
    )
}


function WithinHopsEditor({ value, onChange }: EditorProps<WithinHopsPredicate>) {
    const direction: NonNullable<WithinHopsPredicate['direction']> = value.direction ?? 'both'
    return (
        <div className="flex flex-col gap-2">
            <div>
                <FieldLabel>Anchor URNs</FieldLabel>
                <ChipInput
                    values={value.urns}
                    onChange={(urns) => onChange({ ...value, urns })}
                    placeholder="urn:li:dataset:orders"
                />
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <FieldLabel>Hops</FieldLabel>
                    <NumberField
                        value={value.hops}
                        onChange={(v) => onChange({ ...value, hops: Math.max(1, Math.min(10, v)) })}
                        min={1}
                        max={10}
                    />
                </div>
                <div>
                    <FieldLabel>Direction</FieldLabel>
                    <SelectField
                        value={direction}
                        onChange={(next) => onChange({ ...value, direction: next })}
                        options={HOP_DIRECTION}
                    />
                </div>
            </div>
            <div>
                <FieldLabel>Edge types (optional)</FieldLabel>
                <ChipInput
                    values={value.edgeTypes ?? []}
                    onChange={(types) => onChange({
                        ...value,
                        edgeTypes: types.length > 0 ? types : undefined,
                    })}
                    placeholder="e.g. LINEAGE"
                />
            </div>
        </div>
    )
}


function PathEditor({ value, onChange }: EditorProps<PathPredicate>) {
    const direction: PathDirection = value.direction ?? 'outgoing'
    const edgeClass: EdgeClass = value.edgeClass ?? 'lineage'
    const maxHops = value.maxHops ?? 4
    const maxPaths = value.maxPaths ?? 32
    return (
        <div className="flex flex-col gap-2">
            <div className={cn(
                "rounded-md px-2.5 py-1.5",
                "bg-cyan-500/[0.06] border border-cyan-500/25",
                "text-[10.5px] text-ink-muted leading-snug",
            )}>
                <strong className="text-ink">Path search</strong> returns
                ordered <em>node → edge → node</em> sequences instead of
                flat hits. Other conditions in the same query are ignored
                — the path predicate stands alone.
            </div>
            <div>
                <FieldLabel>Source URNs</FieldLabel>
                <ChipInput
                    values={value.sourceUrns}
                    onChange={(urns) => onChange({ ...value, sourceUrns: urns })}
                    placeholder="urn:li:dataset:orders"
                />
            </div>
            <div>
                <FieldLabel>Target URNs</FieldLabel>
                <ChipInput
                    values={value.targetUrns}
                    onChange={(urns) => onChange({ ...value, targetUrns: urns })}
                    placeholder="urn:li:dataset:reporting"
                />
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <FieldLabel>Direction</FieldLabel>
                    <SelectField
                        value={direction}
                        onChange={(d) => onChange({ ...value, direction: d })}
                        options={PATH_DIRECTION}
                    />
                </div>
                <div>
                    <FieldLabel>Edge class</FieldLabel>
                    <SelectField
                        value={edgeClass}
                        onChange={(ec) => onChange({ ...value, edgeClass: ec })}
                        options={EDGE_CLASS}
                    />
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <FieldLabel>Max hops</FieldLabel>
                    <NumberField
                        value={maxHops}
                        onChange={(v) => onChange({
                            ...value,
                            maxHops: Math.max(1, Math.min(6, v)),
                        })}
                        min={1}
                        max={6}
                    />
                </div>
                <div>
                    <FieldLabel>Max paths returned</FieldLabel>
                    <NumberField
                        value={maxPaths}
                        onChange={(v) => onChange({
                            ...value,
                            maxPaths: Math.max(1, Math.min(128, v)),
                        })}
                        min={1}
                        max={128}
                    />
                </div>
            </div>
            <div>
                <FieldLabel>Edge types (optional, overrides class)</FieldLabel>
                <ChipInput
                    values={value.edgeTypes ?? []}
                    onChange={(types) => onChange({
                        ...value,
                        edgeTypes: types.length > 0 ? types : undefined,
                    })}
                    placeholder="e.g. TRANSFORMS"
                />
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function LeafEditor({
    value, onChange, ctx,
}: {
    value: Predicate
    onChange: (next: Predicate) => void
    ctx: EditorContext
}) {
    switch (value.kind) {
        case 'property':
            return <PropertyEditor value={value} onChange={onChange} ctx={ctx} />
        case 'hasProperty':
            return <HasPropertyEditor value={value} onChange={onChange} ctx={ctx} />
        case 'tag':
            return <TagEditor value={value} onChange={onChange} ctx={ctx} />
        case 'entityType':
            return <EntityTypeEditor value={value} onChange={onChange} ctx={ctx} />
        case 'layer':
            return <LayerEditor value={value} onChange={onChange} ctx={ctx} />
        case 'text':
            return <TextEditor value={value} onChange={onChange} ctx={ctx} />
        case 'degree':
            return <DegreeEditor value={value} onChange={onChange} ctx={ctx} />
        case 'isOrphan':
        case 'isLeaf':
        case 'isRoot':
        case 'hasIncoming':
        case 'hasOutgoing':
            return <SugarEdgeClassEditor value={value} onChange={onChange as (p: SugarPredicate) => void} ctx={ctx} />
        case 'descendantOf':
            return <DescendantOfEditor value={value} onChange={onChange} ctx={ctx} />
        case 'withinHops':
            return <WithinHopsEditor value={value} onChange={onChange} ctx={ctx} />
        case 'path':
            return <PathEditor value={value} onChange={onChange} ctx={ctx} />
        case 'group':
            // Groups are rendered by GroupRow, not as a leaf — but the
            // dispatcher must be total for TS. Render nothing.
            return null
    }
}


/** Two numeric inputs for the ``between`` operator. The backend expects
 *  ``value: [lo, hi]`` — we mirror that wire shape directly so the JSON
 *  editor sees the canonical form without a re-encode step. */
function BetweenField({
    value, onChange,
}: {
    value: unknown
    onChange: (next: [number, number]) => void
}) {
    const tuple: [number, number] = Array.isArray(value) && value.length === 2
        ? [Number(value[0]) || 0, Number(value[1]) || 0]
        : [0, 0]
    return (
        <div className="grid grid-cols-2 gap-2">
            <input
                type="number"
                value={tuple[0]}
                onChange={(e) => onChange([Number(e.target.value) || 0, tuple[1]])}
                placeholder="min"
                className={cn(fieldClass, "tabular-nums font-display")}
            />
            <input
                type="number"
                value={tuple[1]}
                onChange={(e) => onChange([tuple[0], Number(e.target.value) || 0])}
                placeholder="max"
                className={cn(fieldClass, "tabular-nums font-display")}
            />
        </div>
    )
}
