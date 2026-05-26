/**
 * ConditionRow — one filter in the Query Lens, rendered as its own
 * card with labelled cells (FIELD / MATCH / VALUE), generous spacing,
 * and modern operator chips instead of native `<select>`.
 *
 *   ┌─ row card ────────────────────────────────────── × ─┐
 *   │ ⌕  Text in name or description                       │
 *   │                                                      │
 *   │  FIELD              MATCH                            │
 *   │  [ name        ▾]   [ contains   ▾]                  │
 *   │                                                      │
 *   │  TEXT                                                │
 *   │  [ customer                                       ]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * Pattern is borrowed from the existing PredicateBuilder leaf editors:
 * generous padding, mono uppercase field labels, full-width inputs.
 * All `<select>` controls become OperatorMenu chips (portal-mounted)
 * so finite-enum dropdowns render outside the panel's scroll container
 * and don't clip.
 *
 * UnifiedPicker (used for multi-value editors — tags, types, property
 * values) is invoked with ``portal={true}`` for the same reason.
 */
import { ExternalLink, X } from 'lucide-react'
import { type FC, type ReactNode, useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import type {
    DescendantOfPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    LayerPredicate,
    Predicate,
    PropertyOp,
    PropertyPredicate,
    TagPredicate,
    TextMatchMode,
    TextPredicate,
    TextTarget,
} from '@/types/search'

import { useSearchStore } from '@/store/searchStore'

import { UnifiedPicker } from '../builder/editors/UnifiedPicker'

import { OperatorMenu } from './OperatorMenu'
import { RowCard } from './builder-atoms/RowCard'
import { RowMenu } from './builder-atoms/RowMenu'
import { RowSelectionCheckbox } from './builder-atoms/RowSelectionCheckbox'
import type { OpTone } from './builder-atoms/tones'
import type { LayerOption } from './layerOptions'
import { useCanvasAnchorOptions, useCanvasViewRoots } from './useCanvasViewRoots'


/** FE-only augmentation on DescendantOfPredicate so we can route to
 *  the two pickers without altering the wire format. ``'roots'`` (the
 *  default) shows only top-level view roots; ``'any'`` shows every
 *  canvas-loaded node. ``buildRunnablePredicate`` strips this hint
 *  before the predicate goes over the wire. */
export type DescendantOfPredicateWithScope = DescendantOfPredicate & {
    uiScope?: 'roots' | 'any'
}


export interface ConditionRowProps {
    value: Predicate
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
    }
    knownEntityTypes: string[]
    activeEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    autoFocus?: boolean
    onChange: (next: Predicate) => void
    onRemove: () => void
    onOpenAdvanced: () => void
    /** Pressing Enter inside a scalar value field fires this. The
     *  panel wires it to the same dispatch the Run button uses. */
    onSubmit?: () => void
    /** "⋯ → Wrap in AND/OR/NOT group" — replaces this row with a
     *  single-child group of the chosen op at the same position. */
    onWrap?: (op: OpTone) => void
    /** "⋯ → Duplicate" — clone this row in place. */
    onDuplicate?: () => void
    /** Multi-select context: identifies this row in the selection
     *  store. ``parentPath`` is the dot-path of this row's parent
     *  group ('' for the root group); ``index`` is the row's
     *  position inside that parent. When both are supplied a
     *  hover-revealed selection checkbox appears on the left side. */
    parentPath?: string
    index?: number
}


export const ConditionRow: FC<ConditionRowProps> = ({
    value, discovery, knownEntityTypes, activeEntityTypes, discoveredLayers,
    isRunning, autoFocus, onChange, onRemove, onOpenAdvanced, onSubmit,
    onWrap, onDuplicate, parentPath, index,
}) => {
    const meta = getKindMeta(value.kind)
    const incomplete = isIncomplete(value)
    const editor = renderEditor({
        value, onChange, discovery, knownEntityTypes,
        activeEntityTypes, discoveredLayers, isRunning,
        autoFocus: autoFocus ?? false, onSubmit,
        onOpenAdvanced,
    })

    // Multi-select state — only active when the row caller supplied
    // both ``parentPath`` and ``index``. Off otherwise (e.g. when the
    // row renders in a context that doesn't support bulk-grouping).
    const selectable = parentPath !== undefined && index !== undefined
    const selected = useSearchStore((s) =>
        selectable
        && s.selectionParent === parentPath
        && s.selectedIndices.includes(index!),
    )
    const toggleRowSelection = useSearchStore((s) => s.toggleRowSelection)

    return (
        <RowCard tone="neutral" incomplete={incomplete}>
            <div className="group/row flex flex-col gap-3">
                {/* Header — checkbox + icon + descriptive label + actions */}
                <div className="flex items-start gap-2.5">
                    {selectable && (
                        <div className="pt-1">
                            <RowSelectionCheckbox
                                selected={selected}
                                onToggle={() => toggleRowSelection(parentPath!, index!)}
                                ariaLabel={`Select filter row ${meta.label}`}
                            />
                        </div>
                    )}
                    <span className={cn(
                        'inline-flex items-center justify-center shrink-0',
                        'w-6 h-6 rounded-md text-[14px]',
                        'bg-accent-lineage/12 text-accent-lineage',
                    )}>
                        {meta.icon}
                    </span>
                    <div className="flex-1 min-w-0 flex flex-col leading-tight">
                        <span className="text-[12.5px] font-medium text-ink">
                            {meta.label}
                        </span>
                        {meta.description && (
                            <span className="text-[10.5px] text-ink-muted/80 leading-snug">
                                {meta.description}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                        {(onWrap || onDuplicate) && (
                            <RowMenu
                                onWrap={(w) => onWrap?.(w)}
                                onDuplicate={() => onDuplicate?.()}
                                onDelete={onRemove}
                                disabled={isRunning}
                            />
                        )}
                        <button
                            type="button"
                            onClick={onRemove}
                            disabled={isRunning}
                            title="Remove this filter"
                            className={cn(
                                'inline-flex items-center justify-center w-6 h-6 rounded-md',
                                'text-ink-muted/70 hover:text-rose-400 hover:bg-rose-500/10',
                                'transition-colors',
                            )}
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>

                {/* Editor body (per-kind) */}
                {editor && <div className="flex flex-col gap-3 pl-8">{editor}</div>}
            </div>
        </RowCard>
    )
}


// ---------------------------------------------------------------------------
// Editor dispatch
// ---------------------------------------------------------------------------

interface EditorCtx {
    value: Predicate
    onChange: (next: Predicate) => void
    discovery: ConditionRowProps['discovery']
    knownEntityTypes: string[]
    activeEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    autoFocus: boolean
    onOpenAdvanced: () => void
    /** Fires when the user presses Enter inside a scalar editor —
     *  signals "run this query now." Optional; rows that don't have
     *  an Enter-able input ignore it. */
    onSubmit?: () => void
}


function renderEditor(ctx: EditorCtx): ReactNode {
    const { value } = ctx
    switch (value.kind) {
        case 'text':
            return <TextEditor {...ctx} value={value as TextPredicate} />
        case 'entityType':
            return <EntityTypeEditor {...ctx} value={value as EntityTypePredicate} />
        case 'tag':
            return <TagEditor {...ctx} value={value as TagPredicate} />
        case 'layer':
            // Legacy LayerPredicate — kept for backward compatibility
            // with saved queries / JSON pastes that still emit it.
            // New queries use ``descendantOf`` instead (Root in view).
            return <LayerEditor {...ctx} value={value as LayerPredicate} />
        case 'descendantOf': {
            // Two distinct entry points produce DescendantOfPredicate
            // shapes; the FE-only ``uiScope`` hint picks the picker:
            //   - 'roots' (default): only top-level view roots
            //     (Layers). The simple, common case.
            //   - 'any': every canvas-loaded node. Power-user
            //     isolation to deeper subtrees.
            // The BE Cypher is identical for both.
            const scope = (value as DescendantOfPredicateWithScope).uiScope ?? 'roots'
            return scope === 'any'
                ? <InsideSubtreeEditor {...ctx} value={value as DescendantOfPredicateWithScope} />
                : <RootInViewEditor {...ctx} value={value as DescendantOfPredicateWithScope} />
        }
        case 'hasProperty':
            return <HasPropertyEditor {...ctx} value={value as HasPropertyPredicate} />
        case 'property':
            return <PropertyEditor {...ctx} value={value as PropertyPredicate} />
        case 'isOrphan':
        case 'isLeaf':
        case 'isRoot':
        case 'hasIncoming':
        case 'hasOutgoing':
            // Boolean rows: the header label + description already
            // says everything. No editor body needed.
            return null
        case 'withinHops':
        case 'path':
            // No visual editor — these predicate kinds are Code-only.
            // Saved queries that still contain them render this banner;
            // editing happens via the JSON view in the Advanced drawer.
            return <CodeOnlyHint onOpen={ctx.onOpenAdvanced} />
        case 'group': {
            const g = value as GroupPredicate
            return (
                <GroupRowHint
                    op={g.op ?? 'and'}
                    count={g.children.length}
                    onOpen={ctx.onOpenAdvanced}
                />
            )
        }
        default:
            return <span className="text-[11px] text-ink-muted italic">unsupported</span>
    }
}


// ---------------------------------------------------------------------------
// Per-kind editors
// ---------------------------------------------------------------------------

const TEXT_TARGET_OPTIONS: { value: TextTarget; label: string; description?: string }[] = [
    { value: 'name',          label: 'Display name',     description: 'The visible name' },
    { value: 'qualifiedName', label: 'Qualified name',   description: 'Fully qualified path' },
    { value: 'description',   label: 'Description',      description: 'Long-form description' },
    { value: 'tags',          label: 'Tags',             description: 'Tag values' },
    { value: 'any',           label: 'Any field',        description: 'Any text-like field' },
]

// Backend-supported match modes plus a UI-only `wildcard` mode that
// translates `*foo*` / `*foo` / `foo*` / `foo` to the corresponding
// substring / suffix / prefix / exact predicate at submit time. The
// `wildcard` value is filtered out of the wire payload — it's purely
// a frontend mental model.
//
// ``fulltext`` and ``regex`` are intentionally absent (backend compiler
// rejects both with CompileError until the server opts them in).
type TextUiMode = TextMatchMode | 'wildcard'

const TEXT_MATCH_OPTIONS: { value: TextUiMode; label: string; description?: string }[] = [
    { value: 'substring', label: 'Contains',     description: 'Substring match anywhere in the field' },
    { value: 'prefix',    label: 'Starts with',  description: 'Leading-edge match' },
    { value: 'suffix',    label: 'Ends with',    description: 'Trailing-edge match' },
    { value: 'exact',     label: 'Is exactly',   description: 'Full-string equality' },
    { value: 'wildcard',  label: 'Wildcard pattern',
      description: '*term* (contains) · term* (starts with) · *term (ends with) · term (exact)' },
]


/**
 * Parse a user-typed wildcard pattern (`*foo*`, `*foo`, `foo*`, `foo`)
 * into the equivalent backend match mode + stripped value. Multiple
 * leading or trailing asterisks collapse to one. Empty input returns
 * ('substring', '').
 */
function parseWildcardPattern(raw: string): {
    match: Exclude<TextMatchMode, 'fulltext' | 'regex'>
    value: string
} {
    const trimmed = raw.trim()
    if (!trimmed) return { match: 'substring', value: '' }
    const startsW = trimmed.startsWith('*')
    const endsW = trimmed.endsWith('*')
    const stripped = trimmed.replace(/^\*+/, '').replace(/\*+$/, '')
    if (startsW && endsW) return { match: 'substring', value: stripped }
    if (startsW)          return { match: 'suffix',    value: stripped }
    if (endsW)            return { match: 'prefix',    value: stripped }
    return { match: 'exact', value: stripped }
}


function TextEditor({
    value, onChange, autoFocus, onSubmit,
}: Omit<EditorCtx, 'value'> & { value: TextPredicate }) {
    const target = (value.target ?? 'name') as TextTarget
    const storedMatch = (value.match ?? 'substring') as TextMatchMode

    // UI mode is kept LOCAL so picking 'wildcard' isn't lost across
    // re-renders even though the underlying predicate stores one of
    // the four concrete modes (substring/prefix/suffix/exact).
    const [uiMode, setUiMode] = useState<TextUiMode>(storedMatch)
    const [wildcardText, setWildcardText] = useState<string>(value.value)

    // Sync UI back to the stored match if the store changes externally
    // (e.g. JSON edit, template seed) AND the user isn't actively in
    // wildcard mode (wildcard's UI representation can't be re-derived
    // from match alone).
    useEffect(() => {
        if (uiMode !== 'wildcard') setUiMode(storedMatch)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storedMatch])

    const handleUiModeChange = (next: TextUiMode) => {
        setUiMode(next)
        if (next === 'wildcard') {
            // Seed the wildcard input from whatever's currently typed
            // so the user can refine asterisks without retyping.
            setWildcardText(value.value)
        } else {
            onChange({ ...value, match: next })
        }
    }

    const handleInputChange = (raw: string) => {
        if (uiMode === 'wildcard') {
            setWildcardText(raw)
            const { match, value: parsed } = parseWildcardPattern(raw)
            onChange({ ...value, match, value: parsed })
        } else {
            onChange({ ...value, value: raw })
        }
    }

    const inputValue = uiMode === 'wildcard' ? wildcardText : value.value
    const placeholder =
        uiMode === 'wildcard' ? '*term*, *term, term*, or term'
            : uiMode === 'exact'  ? 'exact string…'
                : uiMode === 'prefix' ? 'starts with…'
                    : uiMode === 'suffix' ? 'ends with…'
                        : 'type to search…'

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Field">
                    <OperatorMenu
                        value={target}
                        onChange={(v) => onChange({ ...value, target: v })}
                        options={TEXT_TARGET_OPTIONS}
                        ariaLabel="Text field"
                    />
                </Field>
                <Field label="Match">
                    <OperatorMenu
                        value={uiMode}
                        onChange={handleUiModeChange}
                        options={TEXT_MATCH_OPTIONS}
                        ariaLabel="Match mode"
                    />
                </Field>
            </div>
            <Field label="Text">
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && onSubmit) {
                            e.preventDefault()
                            onSubmit()
                        }
                    }}
                    placeholder={placeholder}
                    autoFocus={autoFocus}
                    className={cn(inputClass, uiMode === 'wildcard' && 'font-mono')}
                />
                {uiMode === 'wildcard' && (
                    <WildcardHelp
                        wildcardText={wildcardText}
                        parsedMatch={storedMatch}
                        parsedValue={value.value}
                    />
                )}
            </Field>
        </div>
    )
}


const ENTITY_TYPE_OP_OPTIONS: { value: 'in' | 'notIn'; label: string }[] = [
    { value: 'in',    label: 'Is in' },
    { value: 'notIn', label: 'Is not in' },
]


function EntityTypeEditor({
    value, onChange, knownEntityTypes, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: EntityTypePredicate }) {
    return (
        <div className="flex flex-col gap-3">
            <Field label="Match">
                <OperatorMenu
                    value={value.op ?? 'in'}
                    onChange={(v) => onChange({ ...value, op: v })}
                    options={ENTITY_TYPE_OP_OPTIONS}
                    ariaLabel="Entity type operator"
                />
            </Field>
            <Field label="Types">
                <UnifiedPicker
                    multiple
                    value={value.values}
                    onChange={(next) => onChange({ ...value, values: next })}
                    options={knownEntityTypes.map((t) => ({ value: t }))}
                    placeholder="pick one or more entity types…"
                    emptyHint="No entity types in schema."
                    autoFocus={autoFocus}
                    portal
                />
            </Field>
        </div>
    )
}


const TAG_OP_OPTIONS: { value: 'has' | 'hasAny' | 'hasAll' | 'notHas'; label: string; description?: string }[] = [
    { value: 'has',    label: 'Has',         description: 'Tagged with this value' },
    { value: 'hasAny', label: 'Has any of',  description: 'At least one of the chosen tags' },
    { value: 'hasAll', label: 'Has all of',  description: 'Every chosen tag is set' },
    { value: 'notHas', label: 'Does not have', description: 'None of the chosen tags is set' },
]


function TagEditor({
    value, onChange, discovery, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: TagPredicate }) {
    return (
        <div className="flex flex-col gap-3">
            <Field label="Match">
                <OperatorMenu
                    value={value.op ?? 'hasAny'}
                    onChange={(v) => onChange({ ...value, op: v })}
                    options={TAG_OP_OPTIONS}
                    ariaLabel="Tag operator"
                />
            </Field>
            <Field label="Tags">
                <UnifiedPicker
                    multiple
                    value={value.values}
                    onChange={(next) => onChange({ ...value, values: next })}
                    options={discovery.tagValues.map((t) => ({ value: t }))}
                    placeholder="pick one or more tags…"
                    emptyHint="No tags discovered for this data source."
                    autoFocus={autoFocus}
                    portal
                />
            </Field>
        </div>
    )
}


function LayerEditor({
    value, onChange, discoveredLayers, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: LayerPredicate }) {
    return (
        <Field label="Layer">
            <UnifiedPicker
                value={value.layerAssignment}
                onChange={(next) => onChange({ ...value, layerAssignment: next })}
                options={discoveredLayers}
                placeholder="pick a layer…"
                emptyHint={
                    'No layers configured on this view. (Layers are defined in the '
                    + 'view\'s reference layout — open the view editor to add them.)'
                }
                autoFocus={autoFocus}
                portal
            />
        </Field>
    )
}


/**
 * RootInViewEditor — the simpler entry: anchor to one or more
 * top-level view roots (Layers in most ontologies). Fed by
 * ``useCanvasViewRoots`` which filters to root entity types only.
 * Multi-select: pick one or more roots → union of their subtrees.
 */
function RootInViewEditor({
    value, onChange, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: DescendantOfPredicateWithScope }) {
    const roots = useCanvasViewRoots()
    return (
        <Field label="Root nodes">
            <UnifiedPicker
                multiple
                value={value.urns}
                onChange={(next) => onChange({ ...value, urns: next })}
                options={roots.map((r) => ({
                    value: r.urn,
                    label: r.displayName,
                    description: r.entityType,
                }))}
                placeholder="pick one or more roots from this view…"
                emptyHint={
                    'No top-level nodes in this view yet. Open the view '
                    + 'or wait for the canvas to load.'
                }
                autoFocus={autoFocus}
                portal
            />
        </Field>
    )
}


/**
 * InsideSubtreeEditor — power-user entry: anchor to ANY canvas-loaded
 * node (Layer, Object, Container, deeper). Fed by
 * ``useCanvasAnchorOptions``. The BE Cypher has no label restriction
 * on the anchor, so this works for arbitrary sub-tree isolation.
 * Multi-select: pick one or more anchors → union of subtrees.
 */
function InsideSubtreeEditor({
    value, onChange, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: DescendantOfPredicateWithScope }) {
    const anchors = useCanvasAnchorOptions()
    return (
        <Field label="Anchor nodes">
            <UnifiedPicker
                multiple
                value={value.urns}
                onChange={(next) => onChange({ ...value, urns: next })}
                options={anchors.map((r) => ({
                    value: r.urn,
                    label: r.displayName,
                    description: r.entityType,
                }))}
                placeholder="pick one or more anchors from this canvas…"
                emptyHint={
                    'No nodes loaded on the canvas yet. Open the view '
                    + 'or wait for it to hydrate.'
                }
                autoFocus={autoFocus}
                portal
            />
        </Field>
    )
}


const HAS_PROPERTY_OP_OPTIONS: { value: 'has' | 'no'; label: string }[] = [
    { value: 'has', label: 'Has property' },
    { value: 'no',  label: 'Does not have property' },
]


function HasPropertyEditor({
    value, onChange, discovery, activeEntityTypes, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: HasPropertyPredicate }) {
    const keys = pickKeyOptions(discovery, activeEntityTypes)
    return (
        <div className="flex flex-col gap-3">
            <Field label="Presence">
                <OperatorMenu
                    value={value.negate ? 'no' : 'has'}
                    onChange={(v) => onChange({ ...value, negate: v === 'no' })}
                    options={HAS_PROPERTY_OP_OPTIONS}
                    ariaLabel="Property presence"
                />
            </Field>
            <Field label="Property key">
                <UnifiedPicker
                    value={value.key}
                    onChange={(next) => onChange({ ...value, key: next })}
                    options={keys.map((k) => ({ value: k }))}
                    placeholder="pick a property key…"
                    emptyHint="No property keys discovered."
                    mono
                    autoFocus={autoFocus}
                    portal
                />
            </Field>
        </div>
    )
}


const PROPERTY_OP_OPTIONS: { value: PropertyOp; label: string }[] = [
    { value: 'eq',         label: 'Equals (=)' },
    { value: 'neq',        label: 'Does not equal (≠)' },
    { value: 'contains',   label: 'Contains' },
    { value: 'startsWith', label: 'Starts with' },
    { value: 'endsWith',   label: 'Ends with' },
    { value: 'gt',         label: 'Greater than (>)' },
    { value: 'gte',        label: 'Greater than or equal (≥)' },
    { value: 'lt',         label: 'Less than (<)' },
    { value: 'lte',        label: 'Less than or equal (≤)' },
    { value: 'in',         label: 'Is one of (IN)' },
    { value: 'notIn',      label: 'Is not one of' },
    { value: 'between',    label: 'Between two values' },
]


function PropertyEditor({
    value, onChange, discovery, activeEntityTypes, autoFocus, onSubmit,
}: Omit<EditorCtx, 'value'> & { value: PropertyPredicate }) {
    const keys = pickKeyOptions(discovery, activeEntityTypes)
    const op: PropertyOp = value.op ?? 'eq'
    const samples = value.key ? discovery.getValueSamples(value.key) : []
    const sampleStrings = samples
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .filter((s) => s.length > 0)
    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Property">
                    <UnifiedPicker
                        value={value.key}
                        onChange={(next) => onChange({ ...value, key: next })}
                        options={keys.map((k) => ({ value: k }))}
                        placeholder="property…"
                        emptyHint="No property keys discovered."
                        mono
                        autoFocus={autoFocus}
                        portal
                    />
                </Field>
                <Field label="Operator">
                    <OperatorMenu
                        value={op}
                        onChange={(v) => onChange({ ...value, op: v })}
                        options={PROPERTY_OP_OPTIONS}
                        ariaLabel="Property operator"
                    />
                </Field>
            </div>
            <Field label="Value">
                {sampleStrings.length > 0 ? (
                    <UnifiedPicker
                        value={value.value == null ? '' : String(value.value)}
                        onChange={(next) => onChange({ ...value, value: coerceValue(next) })}
                        options={sampleStrings.map((s) => ({ value: s }))}
                        placeholder="pick or type a value…"
                        emptyHint="No samples discovered — type a value."
                        portal
                    />
                ) : (
                    <input
                        type="text"
                        value={value.value == null ? '' : String(value.value)}
                        onChange={(e) => onChange({ ...value, value: coerceValue(e.target.value) })}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && onSubmit) {
                                e.preventDefault()
                                onSubmit()
                            }
                        }}
                        placeholder="type a value…"
                        className={inputClass}
                    />
                )}
            </Field>
        </div>
    )
}


function CodeOnlyHint({ onOpen }: { onOpen: () => void }) {
    return (
        <div className={cn(
            'rounded-lg border border-glass-border/60 bg-canvas-base/30',
            'px-3 py-2.5 flex items-center justify-between gap-3',
        )}>
            <span className="text-[11.5px] text-ink-muted">
                This filter lives in Code mode — open the JSON view to edit it.
            </span>
            <button
                type="button"
                onClick={onOpen}
                className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md shrink-0',
                    'text-[11px] font-medium text-accent-lineage',
                    'bg-accent-lineage/10 hover:bg-accent-lineage/20 transition-colors',
                )}
            >
                <ExternalLink className="w-3 h-3" />
                Open in Code
            </button>
        </div>
    )
}


function GroupRowHint({
    op, count, onOpen,
}: { op: string; count: number; onOpen: () => void }) {
    return (
        <div className={cn(
            'rounded-lg border border-glass-border/60 bg-canvas-base/30',
            'px-3 py-2.5 flex items-center justify-between gap-3',
        )}>
            <span className="text-[11.5px] text-ink-muted">
                <span className="font-mono uppercase font-semibold text-ink">{op}</span>{' '}
                group · {count} condition{count === 1 ? '' : 's'}
            </span>
            <button
                type="button"
                onClick={onOpen}
                className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md shrink-0',
                    'text-[11px] font-medium text-accent-lineage',
                    'bg-accent-lineage/10 hover:bg-accent-lineage/20 transition-colors',
                )}
            >
                <ExternalLink className="w-3 h-3" />
                Edit in Advanced
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Wildcard help panel — shown when user selects 'Wildcard pattern' mode
// ---------------------------------------------------------------------------

/**
 * Always-visible explainer that maps wildcard syntax to its meaning,
 * plus a live "Parses to …" line driven by the user's current input.
 * Surfaces the glob semantics up front so the user doesn't expect
 * ``*foo`` to mean "contains foo" (it means "ends with foo").
 */
function WildcardHelp({
    wildcardText, parsedMatch, parsedValue,
}: {
    wildcardText: string
    parsedMatch: TextMatchMode
    parsedValue: string
}) {
    const rows: { pat: string; means: string }[] = [
        { pat: '*term*', means: 'Contains the word anywhere' },
        { pat: 'term*',  means: 'Starts with the word' },
        { pat: '*term',  means: 'Ends with the word' },
        { pat: 'term',   means: 'Matches the exact word' },
    ]
    const parsedLabel = (() => {
        switch (parsedMatch) {
            case 'substring': return 'Contains'
            case 'prefix':    return 'Starts with'
            case 'suffix':    return 'Ends with'
            case 'exact':     return 'Is exactly'
            default:          return parsedMatch
        }
    })()
    return (
        <div className={cn(
            'mt-1 rounded-lg border border-accent-lineage/20',
            'bg-accent-lineage/[0.04] px-2.5 py-2 flex flex-col gap-1.5',
        )}>
            {wildcardText.trim() && (
                <div className={cn(
                    'flex items-baseline gap-2 text-[11px] leading-snug',
                    'border-b border-accent-lineage/15 pb-1.5',
                )}>
                    <span className="text-ink-muted">→ Parses to</span>
                    <span className="font-mono text-accent-lineage">
                        {parsedLabel}{parsedValue ? ` "${parsedValue}"` : ''}
                    </span>
                </div>
            )}
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10.5px]">
                {rows.map((r) => (
                    <div key={r.pat} className="contents">
                        <span className="font-mono text-accent-lineage tabular-nums">
                            {r.pat}
                        </span>
                        <span className="text-ink-muted">
                            {r.means}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Atoms — Field wrapper + shared input className
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                {label}
            </span>
            {children}
        </label>
    )
}


const inputClass = cn(
    'w-full px-3 py-2 rounded-lg',
    'bg-canvas-elevated/60 border border-glass-border',
    'text-[13px] text-ink placeholder:text-ink-muted/55',
    'focus:outline-none focus:border-accent-lineage/55',
    'focus:ring-2 focus:ring-accent-lineage/20',
    'hover:border-glass-border/80 transition-all',
)


// ---------------------------------------------------------------------------
// Meta + helpers
// ---------------------------------------------------------------------------

interface KindMeta {
    icon: string
    label: string
    description?: string
}


function getKindMeta(kind: Predicate['kind']): KindMeta {
    switch (kind) {
        case 'text': return {
            icon: '⌕', label: 'Text in name or description',
            description: 'Substring or pattern match against name, qualified name, description, or tags.',
        }
        case 'entityType': return {
            icon: '◇', label: 'Entity type',
            description: 'Restrict to specific node types from the view\'s schema.',
        }
        case 'tag': return {
            icon: '#', label: 'Tag',
            description: 'Match nodes by their assigned tags.',
        }
        case 'layer': return {
            icon: '⌬', label: 'Layer (legacy)',
            description:
                'Legacy layer-assignment filter. New queries should use '
                + '"Root in view" instead — same intent, more reliable matching.',
        }
        case 'hasProperty': return {
            icon: '⚑', label: 'Property is set',
            description: 'Whether a specific property key is present on the node.',
        }
        case 'property': return {
            icon: '⊜', label: 'Property value',
            description: 'Compare a property against a value with =, ≠, <, >, contains, etc.',
        }
        case 'isOrphan': return {
            icon: '⊘', label: 'No lineage edges',
            description: 'Disconnected nodes — no upstream producers, no downstream consumers.',
        }
        case 'isLeaf': return {
            icon: '↓', label: 'No downstream lineage',
            description: 'Nodes with no outgoing lineage edges — terminal data products.',
        }
        case 'isRoot': return {
            icon: '↑', label: 'No upstream lineage',
            description: 'Nodes with no incoming lineage edges — sources of truth.',
        }
        case 'hasIncoming': return {
            icon: '⇣', label: 'Has upstream lineage',
            description: 'At least one incoming lineage edge.',
        }
        case 'hasOutgoing': return {
            icon: '⇡', label: 'Has downstream lineage',
            description: 'At least one outgoing lineage edge.',
        }
        case 'descendantOf': return {
            icon: '⌂', label: 'Root in view is…',
            description:
                'Restrict to entities under one of the view\'s top-level '
                + 'containers (the same roots you see at the top of the '
                + 'canvas tree).',
        }
        case 'withinHops': return {
            icon: '⇿', label: 'Within N hops',
            description: 'N-hop neighbourhood of an anchor URN.',
        }
        case 'path': return {
            icon: '⤇', label: 'Path between two nodes',
            description: 'Lineage paths from a source URN to a target URN.',
        }
        case 'group': return {
            icon: '⊕', label: 'Composite group',
            description: 'OR / NOT composition — edit in Advanced builder.',
        }
        default: return { icon: '·', label: String(kind) }
    }
}


function pickKeyOptions(
    discovery: ConditionRowProps['discovery'],
    activeEntityTypes: string[],
): string[] {
    if (activeEntityTypes.length === 0) return discovery.allKeys
    const union = new Set<string>()
    for (const t of activeEntityTypes) {
        const keys = discovery.keysByEntityType[t]
        if (!keys) continue
        for (const k of keys) union.add(k)
    }
    return union.size > 0 ? Array.from(union).sort() : discovery.allKeys
}


function coerceValue(s: string): unknown {
    const t = s.trim()
    if (t === '') return ''
    if (t === 'true') return true
    if (t === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return s
}


function isIncomplete(p: Predicate): boolean {
    switch (p.kind) {
        case 'text':         return !p.value.trim()
        case 'entityType':   return p.values.length === 0
        case 'tag':          return p.values.length === 0
        case 'layer':        return !p.layerAssignment.trim()
        case 'hasProperty':  return !p.key.trim()
        case 'property':     return !p.key.trim()
        case 'descendantOf': return p.urns.length === 0
        case 'withinHops':   return p.urns.length === 0
        case 'path':         return p.sourceUrns.length === 0 || p.targetUrns.length === 0
        default:             return false
    }
}


export { isIncomplete as isRowIncomplete }
