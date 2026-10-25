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
import { ExternalLink, KeyRound, Type, X } from 'lucide-react'
import { type FC, type ReactNode, memo, useEffect, useMemo, useState } from 'react'

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import { formatUrnLabel } from '@/lib/urnLabels'
import { cn } from '@/lib/utils'
import type {
    DegreePredicate,
    DescendantOfPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    IsPredicate,
    LayerPredicate,
    PathPredicate,
    Predicate,
    PropertyOp,
    PropertyPredicate,
    RelatedPredicate,
    TagPredicate,
    TextMatchMode,
    TextPredicate,
    TextTarget,
} from '@/types/search'

import { useEntityTypes } from '@/store/schema'
import { useSearchStore } from '@/store/searchStore'

import { UnifiedPicker } from '../builder/editors/UnifiedPicker'
import type { ValueSuggester } from '../builder/useDiscovery'
import { inputClass } from '../typed/fieldStyles'
import {
    arityOf,
    autoTypeOf,
    comparesAs,
    isNegative,
    KEY_OPS,
    operatorsFor,
    predicateType,
} from '../typed/operators'
import { TypedValueEditor } from '../typed/TypedValueEditor'
import { useValueSuggestions } from '../typed/useValueSuggestions'
import { parseDuration, recode, valueProblem } from '../typed/valueCodec'
import { TYPE_META, VALUE_TYPES, type ValueType, observeType } from '../typed/valueTypes'

import { EdgeCountEditor, EdgeSetField } from './EdgeShapeEditors'
import { NodeRefList } from './NodeRefPicker'
import { OperatorMenu } from './OperatorMenu'
import { PathEditor } from './PathEditor'
import { RelationshipEditor } from './RelationshipEditor'
import { axisMeta } from './relations'
import { shapeLabel } from './vocabulary/edgeWords'
import { RowCard } from './builder-atoms/RowCard'
import { RowMenu } from './builder-atoms/RowMenu'
import { RowSelectionCheckbox } from './builder-atoms/RowSelectionCheckbox'
import type { OpTone } from './builder-atoms/tones'
import type { LayerOption } from './layerOptions'
import { useCanvasAnchorOptions, useTopLevelCanvasContainers } from './useCanvasViewRoots'


/** FE-only augmentation on DescendantOfPredicate so we can route to
 *  the two pickers without altering the wire format. ``'roots'`` (the
 *  default) shows only top-level view roots; ``'any'`` shows every
 *  canvas-loaded node — the shape the results pane writes when you
 *  search inside a group.
 *
 *  The hint DOES travel with the predicate (the backend ignores unknown
 *  fields), and deliberately so: it's what lets a saved or recent query
 *  reopen in the editor the user built it in. */
export type DescendantOfPredicateWithScope = DescendantOfPredicate & {
    /** ``'name'``: anchors named by their path of display names. */
    uiScope?: 'roots' | 'any' | 'name'
}


export interface ConditionRowProps {
    value: Predicate
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
        /** Counted suggestions across the view; samples when absent. */
        suggestValues?: ValueSuggester
    }
    knownEntityTypes: string[]
    activeEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    autoFocus?: boolean
    onChange: (next: Predicate) => void
    onRemove: () => void
    /** Omitted where there is no Advanced drawer (the rule editor). */
    onOpenAdvanced?: () => void
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


const ConditionRowImpl: FC<ConditionRowProps> = ({
    value, discovery, knownEntityTypes, activeEntityTypes, discoveredLayers,
    isRunning, autoFocus, onChange, onRemove, onOpenAdvanced, onSubmit,
    onWrap, onDuplicate, parentPath, index,
}) => {
    const meta = getKindMeta(value)
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


/**
 * Memoised so that — inside VisualQueryBuilder — editing one row doesn't
 * re-render the sibling rows. The builder hands every row referentially
 * stable props (value, discovery, callbacks), so only the row whose
 * ``value`` actually changed re-renders. Internal store subscriptions
 * (bulk-select) still force their own updates independently of memo.
 */
export const ConditionRow = memo(ConditionRowImpl)


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
    onOpenAdvanced?: () => void
    /** Fires when the user presses Enter inside a scalar editor —
     *  signals "run this query now." Optional; rows that don't have
     *  an Enter-able input ignore it. */
    onSubmit?: () => void
}


export type ConditionEditorProps = Omit<EditorCtx, 'autoFocus'> & { autoFocus?: boolean }

/** A condition's editor alone — a row without its card. The Sentence
 *  builder's popovers edit a clause with exactly what Form edits it with. */
export function ConditionEditor(props: ConditionEditorProps) {
    return <>{renderEditor({ ...props, autoFocus: props.autoFocus ?? false })}</>
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
            const d = value as DescendantOfPredicateWithScope
            const scope = d.uiScope ?? (d.refs?.length && !d.urns?.length ? 'name' : 'roots')
            if (scope === 'name') {
                return (
                    <Field label="Containers, by name" group>
                        <NodeRefList value={d.refs ?? []} autoFocus={ctx.autoFocus}
                                     disabled={ctx.isRunning}
                                     onChange={(refs) => ctx.onChange({ ...d, refs })} />
                    </Field>
                )
            }
            return scope === 'any'
                ? <InsideSubtreeEditor {...ctx} value={d} />
                : <RootInViewEditor {...ctx} value={d} />
        }
        case 'hasProperty':
            return <HasPropertyEditor {...ctx} value={value as HasPropertyPredicate} />
        case 'is': {
            const p = value as IsPredicate
            return (
                <Field label="Entities" group>
                    <NodeRefList value={p.refs} autoFocus={ctx.autoFocus} disabled={ctx.isRunning}
                                 onChange={(refs) => ctx.onChange({ ...p, refs })} />
                </Field>
            )
        }
        case 'related':
            return (
                <RelationshipEditor value={value as RelatedPredicate} onChange={ctx.onChange}
                                    discovery={ctx.discovery} knownEntityTypes={ctx.knownEntityTypes}
                                    discoveredLayers={ctx.discoveredLayers} isRunning={ctx.isRunning}
                                    onSubmit={ctx.onSubmit} />
            )
        case 'path':
            return (
                <PathEditor value={value as PathPredicate} onChange={ctx.onChange}
                            discovery={ctx.discovery} knownEntityTypes={ctx.knownEntityTypes}
                            discoveredLayers={ctx.discoveredLayers} isRunning={ctx.isRunning}
                            onSubmit={ctx.onSubmit} />
            )
        case 'property':
            return <PropertyEditor {...ctx} value={value as PropertyPredicate} />
        case 'isOrphan':
        case 'isLeaf':
        case 'isRoot':
        case 'hasIncoming':
        case 'hasOutgoing':
            // The header names the shape; the body picks the edges it counts.
            return <EdgeSetField value={value} onChange={ctx.onChange} disabled={ctx.isRunning} />
        case 'degree':
            return <EdgeCountEditor value={value as DegreePredicate} onChange={ctx.onChange}
                                    disabled={ctx.isRunning} />
        case 'all':
            // The header label + description already says everything.
            return null
        case 'withinHops':
            // No visual editor — Code-only. Saved queries that still
            // contain it render this banner; editing happens via the JSON
            // view in the Advanced drawer.
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

/** Shared with the canvas header's Match menu, so one match mode is
 *  spelled one way across the builder and the quick search box. */
export const TEXT_MATCH_OPTIONS: { value: TextUiMode; label: string; description?: string }[] = [
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
    // Each type by the name the ontology gives it, not its id.
    const entityTypes = useEntityTypes()
    const options = useMemo(() => knownEntityTypes.map((t) => ({
        value: t, label: entityTypes.find((e) => e.id === t)?.name || t,
    })), [knownEntityTypes, entityTypes])
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
                    options={options}
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
    const roots = useTopLevelCanvasContainers()
    return (
        <Field label="Root nodes">
            <UnifiedPicker
                multiple
                value={value.urns ?? []}
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
    // The canvas only knows about nodes it has loaded, and an anchor
    // picked out of search results usually isn't one of them — that's
    // often the point of scoping to it. Fold any such URN in as its own
    // option so the picker shows "GOLD", not a bare URN or a blank.
    const options = useMemo(() => {
        const known = new Set(anchors.map((r) => r.urn))
        const extra = (value.urns ?? [])
            .filter((urn) => urn && !known.has(urn))
            .map((urn) => ({
                value: urn,
                label: formatUrnLabel(urn),
                description: 'not loaded on this canvas',
            }))
        return [
            ...anchors.map((r) => ({
                value: r.urn,
                label: r.displayName,
                description: r.entityType,
            })),
            ...extra,
        ]
    }, [anchors, value.urns])
    return (
        <Field label="Anchor nodes">
            <UnifiedPicker
                multiple
                value={value.urns ?? []}
                onChange={(next) => onChange({ ...value, urns: next })}
                options={options}
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

type KeyMatch = NonNullable<HasPropertyPredicate['keyMatch']>

const KEY_MATCH_OPTIONS: { value: KeyMatch; label: string; description: string }[] = [
    { value: 'exact',    label: 'Named',            description: 'This exact property' },
    { value: 'prefix',   label: 'Name starts with', description: 'Any property whose name starts with the text' },
    { value: 'contains', label: 'Name contains',    description: 'Any property whose name contains the text' },
]


function HasPropertyEditor({
    value, onChange, discovery, activeEntityTypes, autoFocus,
}: Omit<EditorCtx, 'value'> & { value: HasPropertyPredicate }) {
    const keys = pickKeyOptions(discovery, activeEntityTypes)
    const match: KeyMatch = value.keyMatch ?? 'exact'
    const needle = value.key.trim().toLowerCase()
    const matching = match === 'exact' || !needle ? [] : keys.filter((k) => (
        match === 'prefix' ? k.toLowerCase().startsWith(needle) : k.toLowerCase().includes(needle)
    ))
    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Presence">
                    <OperatorMenu
                        value={value.negate ? 'no' : 'has'}
                        onChange={(v) => onChange({ ...value, negate: v === 'no' })}
                        options={HAS_PROPERTY_OP_OPTIONS}
                        ariaLabel="Property presence"
                    />
                </Field>
                <Field label="Match">
                    <OperatorMenu
                        value={match}
                        onChange={(m) => onChange({ ...value, keyMatch: m })}
                        options={KEY_MATCH_OPTIONS}
                        ariaLabel="Match property names"
                    />
                </Field>
            </div>
            <Field label={match === 'exact' ? 'Property key' : 'Part of the name'}>
                {match === 'exact' ? (
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
                ) : (
                    <input
                        type="text"
                        value={value.key}
                        onChange={(e) => onChange({ ...value, key: e.target.value })}
                        placeholder="e.g. owner"
                        autoFocus={autoFocus}
                        className={cn(inputClass, 'font-mono')}
                    />
                )}
            </Field>
            {match !== 'exact' && needle && (
                <p className="text-[11px] text-ink-muted -mt-1">
                    {matching.length === 0
                        ? 'No discovered property matches yet — every entity is still checked.'
                        : <>Matches {matching.length === 1 ? 'the known property' : `${matching.length} known properties`}{' '}
                            <span className="font-mono text-ink">{matching.slice(0, 5).join(', ')}</span>
                            {matching.length > 5 && ` and ${matching.length - 5} more`}.</>}
                </p>
            )}
        </div>
    )
}


const TYPE_NOUNS: Record<ValueType, string> = {
    string: 'text', number: 'numbers', boolean: 'true or false', date: 'dates',
}

const TYPE_OPTIONS = VALUE_TYPES.map((t) => ({
    value: t, label: TYPE_META[t].label, description: TYPE_META[t].description,
}))

const COMPARE_WITH: SegmentedOption<'value' | 'key'>[] = [
    { value: 'value', label: 'A value', icon: Type },
    { value: 'key', label: 'Another property', icon: KeyRound },
]


/** One property compared to a value — typed. The row compares as a TYPE
 *  (text, number, true/false, date): guessed from the property's values,
 *  overridable, and stamped on the predicate so a saved query keeps its
 *  meaning. The operator menu, the value editor and the checks follow it.
 *  Or compared with another property of the same entity ("freshness hours
 *  is greater than SLA hours"): =, ≠ and the orders, an order as numbers
 *  and equality as text unless the type says otherwise. */
function PropertyEditor({
    value, onChange, discovery, activeEntityTypes, autoFocus, onSubmit,
}: Omit<EditorCtx, 'value'> & { value: PropertyPredicate }) {
    const keys = pickKeyOptions(discovery, activeEntityTypes)
    const op: PropertyOp = value.op ?? 'eq'
    const samples = value.key ? discovery.getValueSamples(value.key) : []
    const observed = observeType(samples)
    const declared = value.valueType && value.valueType !== 'auto' ? value.valueType : null
    // Compared with another property of the same entity rather than a value.
    const versusKey = value.valueKey != null
    // A row from before types runs as its value decides — show that.
    const type: ValueType = declared ?? (versusKey ? predicateType(value)
        : valueProblem(op, 'auto', value.value) === null && arityOf(op) !== 'none'
            ? autoTypeOf(op, value.value) : observed.type)
    const kind = comparesAs(op, type)
    const arity = arityOf(op)
    const problem = value.key.trim() && !versusKey ? valueProblem(op, type, value.value) : null
    // The most common values across the whole view, for what is typed —
    // the discovery sample alone showed a handful.
    const [valueQuery, setValueQuery] = useState('')
    const suggested = useValueSuggestions(discovery.suggestValues, value.key, valueQuery)

    const update = (patch: Partial<PropertyPredicate>, nextType: ValueType = type) =>
        onChange({ ...value, ...patch, valueType: nextType })
    // A new property or type keeps the operator when it still applies and
    // re-reads the value in the new type ("15" ↔ 15).
    const retype = (patch: Partial<PropertyPredicate>, nextType: ValueType, list: boolean) => {
        const keep = operatorsFor(nextType, { list }).some((o) => o.value === op)
        const nextOp: PropertyOp = keep ? op : 'eq'
        if (versusKey) {
            update({ ...patch, op: KEY_OPS.includes(nextOp) ? nextOp : 'eq' }, nextType)
            return
        }
        update({ ...patch, op: nextOp, value: reshapeValue(recode(value.value, nextType), op, nextOp) }, nextType)
    }
    const compareWith = (target: 'value' | 'key') => {
        const { value: _v, valueKey: _k, includeMissing: _m, ...rest } = value
        onChange(target === 'key' ? { ...rest, valueKey: '' } : rest)
    }
    const opChoices = operatorsFor(type, { list: observed.list, current: op })
        .filter((o) => !versusKey || KEY_OPS.includes(o.value))

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Property">
                    <UnifiedPicker
                        value={value.key}
                        onChange={(next) => {
                            const seen = observeType(next ? discovery.getValueSamples(next) : [])
                            retype({ key: next }, seen.type, seen.list)
                        }}
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
                        onChange={(v) => update(versusKey ? { op: v } : { op: v, value: reshapeValue(value.value, op, v) })}
                        options={opChoices}
                        ariaLabel="Property operator"
                    />
                </Field>
            </div>
            {KEY_OPS.includes(op) && (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">Compare with</span>
                    <Segmented options={COMPARE_WITH} value={versusKey ? 'key' : 'value'}
                               onChange={compareWith} label="Compare with" />
                </div>
            )}
            {versusKey ? (
                <Field label="Other property">
                    <UnifiedPicker
                        value={value.valueKey ?? ''}
                        onChange={(next) => update({ valueKey: next })}
                        options={keys.filter((k) => k !== value.key).map((k) => ({ value: k }))}
                        placeholder="the property to compare with…"
                        emptyHint="No other property keys discovered."
                        mono
                        portal
                    />
                </Field>
            ) : arity !== 'none' && (
                <Field label={arity === 'many' ? 'Values' : arity === 'pair' ? 'Range'
                    : arity === 'duration' ? 'Within the last' : 'Value'}>
                    <TypedValueEditor
                        op={op}
                        type={type}
                        value={value.value}
                        onChange={(next) => update({ value: next })}
                        samples={samples}
                        suggestions={suggested?.values}
                        onQueryChange={discovery.suggestValues ? setValueQuery : undefined}
                        onSubmit={onSubmit}
                    />
                </Field>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <OperatorMenu
                    value={type}
                    onChange={(t) => retype({}, t, observed.list)}
                    options={TYPE_OPTIONS}
                    chipPrefix="Compare as"
                    size="sm"
                    ariaLabel="Compare as"
                />
                {kind === 'string' && arity !== 'none' && (
                    <CheckToggle
                        checked={!!value.caseSensitive}
                        onChange={(on) => update({ caseSensitive: on })}
                    >
                        Match case
                    </CheckToggle>
                )}
                {isNegative(op) && !versusKey && (
                    <CheckToggle
                        checked={!!value.includeMissing}
                        onChange={(on) => update({ includeMissing: on })}
                    >
                        Include entities without {value.key.trim() ? <span className="font-mono">{value.key}</span> : 'it'}
                    </CheckToggle>
                )}
            </div>
            {suggested && !suggested.complete && arity !== 'none' && (
                <p className="text-[11px] text-ink-muted -mt-1">
                    Values listed from part of this view — it is large. Any value can still be typed.
                </p>
            )}
            {observed.mixed && kind !== 'string' && arity !== 'none' && (
                <p className="text-[11px] text-ink-muted -mt-1">
                    Some values of this property are not {TYPE_NOUNS[kind]} — those entities
                    never match this comparison.
                </p>
            )}
            {problem && (
                <p className="text-[11px] text-ink-muted -mt-1">
                    Not applied yet — {problem}.
                </p>
            )}
        </div>
    )
}


function CheckToggle({
    checked, onChange, children,
}: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
    return (
        <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted hover:text-ink cursor-pointer select-none">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent-lineage"
            />
            {children}
        </label>
    )
}


function CodeOnlyHint({ onOpen }: { onOpen?: () => void }) {
    return (
        <div className={cn(
            'rounded-lg border border-glass-border/60 bg-canvas-base/30',
            'px-3 py-2.5 flex items-center justify-between gap-3',
        )}>
            <span className="text-[11.5px] text-ink-muted">
                {onOpen
                    ? 'This filter lives in Code mode — open the JSON view to edit it.'
                    : "This filter is edited as JSON in Advanced Search — it can't be changed here."}
            </span>
            {onOpen && <button
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
            </button>}
        </div>
    )
}


function GroupRowHint({
    op, count, onOpen,
}: { op: string; count: number; onOpen?: () => void }) {
    return (
        <div className={cn(
            'rounded-lg border border-glass-border/60 bg-canvas-base/30',
            'px-3 py-2.5 flex items-center justify-between gap-3',
        )}>
            <span className="text-[11.5px] text-ink-muted">
                <span className="font-mono uppercase font-semibold text-ink">{op}</span>{' '}
                group · {count} condition{count === 1 ? '' : 's'}
            </span>
            {onOpen && <button
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
            </button>}
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

/** ``group``: it holds several controls (a list of names), so it is a
 *  group, not a <label> — a label hands a click anywhere inside it to its
 *  first control, which there could be "Use its name". */
function Field({ label, children, group }: { label: string; children: ReactNode; group?: boolean }) {
    const Tag = group ? 'div' : 'label'
    return (
        <Tag className="flex flex-col gap-1.5 min-w-0" {...(group ? { role: 'group', 'aria-label': label } : {})}>
            <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                {label}
            </span>
            {children}
        </Tag>
    )
}


// ---------------------------------------------------------------------------
// Meta + helpers
// ---------------------------------------------------------------------------

interface KindMeta {
    icon: string
    label: string
    description?: string
}


function getKindMeta(p: Predicate): KindMeta {
    switch (p.kind) {
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
            description: 'Whether a property is present — by its exact key, or by part of its name.',
        }
        case 'property': return {
            icon: '⊜', label: 'Property value',
            description: 'Compare a property as text, a number, true/false or a date — equals, '
                + 'contains, greater than, between, within the last, is empty and more.',
        }
        case 'isOrphan': return {
            icon: '⊘', label: shapeLabel('isOrphan', p),
            description: 'No edges of these, in or out.',
        }
        case 'isLeaf': return {
            icon: '↓', label: shapeLabel('isLeaf', p),
            description: 'No outgoing edges of these — nothing leaves it.',
        }
        case 'isRoot': return {
            icon: '↑', label: shapeLabel('isRoot', p),
            description: 'No incoming edges of these — nothing points to it.',
        }
        case 'hasIncoming': return {
            icon: '⇣', label: shapeLabel('hasIncoming', p),
            description: 'At least one incoming edge of these.',
        }
        case 'hasOutgoing': return {
            icon: '⇡', label: shapeLabel('hasOutgoing', p),
            description: 'At least one outgoing edge of these.',
        }
        case 'descendantOf': {
            // Two entry points, two vocabularies. 'any' is the row the
            // results pane writes when you search inside a group, and
            // its anchor is usually a mid-tree container — calling that
            // "Root in view" would be wrong.
            const scope = (p as DescendantOfPredicateWithScope).uiScope
            if (scope === 'name' || (!scope && p.refs?.length && !p.urns?.length)) {
                return {
                    icon: '⌂', label: 'Inside a container named…',
                    description:
                        'Entities under a container named by its path — '
                        + '"Country / United Kingdom" — the same in every environment.',
                }
            }
            if (scope === 'any') {
                return {
                    icon: '⌂', label: 'Inside…',
                    description:
                        'Restrict to entities contained by a specific node '
                        + 'anywhere in the graph, at any depth beneath it.',
                }
            }
            return {
                icon: '⌂', label: 'Root in view is…',
                description:
                    'Restrict to entities under one of the view\'s top-level '
                    + 'containers (the same roots you see at the top of the '
                    + 'canvas tree).',
            }
        }
        case 'withinHops': return {
            icon: '⇿', label: 'Within N hops',
            description: 'N-hop neighbourhood of an anchor URN.',
        }
        case 'path': return {
            icon: '⤇', label: 'Paths',
            description: 'Every route from where it starts to where it ends — each end named '
                + 'entities or a condition — through edges you choose.',
        }
        case 'degree': return {
            icon: '#', label: 'Number of edges',
            description: 'How many edges it has — which way, and through which edges.',
        }
        case 'all': return {
            icon: '∗', label: 'Every entity',
            description: 'Every entity in the view.',
        }
        case 'is': return {
            icon: '◎', label: 'Is a named entity',
            description: 'One entity — or several — by its path of names, or by URN.',
        }
        case 'related': {
            // The body leads with the verb; the header says what kind it is.
            const link = axisMeta(p.axis).lineage
            return {
                icon: link ? '⇄' : '⊶',
                label: link ? 'Connection' : 'Hierarchy',
                description: link
                    ? 'A condition on what it is connected to — steps and edges under More options.'
                    : 'A condition on its containers or what it contains.',
            }
        }
        case 'group': return {
            icon: '⊕', label: 'Composite group',
            description: 'OR / NOT composition — edit in Advanced builder.',
        }
        default: return { icon: '·', label: String(p.kind) }
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


/** Carry the value across an operator change instead of dropping it: one
 *  value becomes a one-item list, a list's first item becomes the value, a
 *  pair keeps its first bound. A duration only means something to
 *  "within the last", and presence operators take no value. */
function reshapeValue(v: unknown, from: PropertyOp, to: PropertyOp): unknown {
    const arity = arityOf(to)
    if (arity === 'none') return undefined
    if (arity === 'duration') return parseDuration(v) ? v : ''
    const items = arityOf(from) === 'duration' ? []
        : (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== '')
    if (arity === 'many') return items
    if (arity === 'pair') return [items[0] ?? '', items[1] ?? '']
    return items[0] ?? ''
}


function isIncomplete(p: Predicate): boolean {
    switch (p.kind) {
        case 'text':         return !p.value.trim()
        case 'entityType':   return p.values.length === 0
        case 'tag':          return p.values.length === 0
        case 'layer':        return !p.layerAssignment.trim()
        case 'hasProperty':  return !p.key.trim()
        case 'property':     return !p.key.trim() || (p.valueKey != null ? !p.valueKey.trim()
            : valueProblem(p.op ?? 'eq', p.valueType ?? 'auto', p.value) !== null)
        case 'descendantOf': return !p.urns?.length && !p.refs?.length
        case 'withinHops':   return !p.urns?.length && !p.refs?.length
        case 'path':
            return !(p.sourceUrns?.length || p.sourceRefs?.length || p.sourceWhere)
                || !(p.targetUrns?.length || p.targetRefs?.length || p.targetWhere)
                || [p.sourceWhere, p.targetWhere].some((w) => !!w && hasIncompleteLeaf(w))
        case 'is':           return !p.refs.length || p.refs.some((r) => !r.urn && !r.path?.length)
        // A relationship with no condition is complete: any relative will do.
        case 'related':      return p.edgeTypes?.length === 0 || (!!p.where && hasIncompleteLeaf(p.where))
        // Edge types to pick, not picked yet.
        case 'isOrphan':
        case 'isLeaf':
        case 'isRoot':
        case 'hasIncoming':
        case 'hasOutgoing':
        case 'degree':       return p.edgeTypes?.length === 0
        default:             return false
    }
}


/** Whether a condition, or any condition nested in it, is unfinished — a
 *  relationship's own would reach the server, which refuses it. */
function hasIncompleteLeaf(p: Predicate): boolean {
    if (p.kind === 'group') return p.children.some(hasIncompleteLeaf)
    return isIncomplete(p)
}


export { isIncomplete as isRowIncomplete }
