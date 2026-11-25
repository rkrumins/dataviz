/**
 * DisplayRuleEditor — author one display rule, in three steps:
 *
 *   1. what it applies to: entities (a tag on their cards) or relationships
 *      (a look for their lines);
 *   2. the condition — for entities, the Advanced-Search flat-filter builder
 *      (``VisualQueryBuilder``) verbatim; for relationships, the Connections
 *      search builder (``ConnectionBuilder``): From and To (each optional),
 *      the relationship types and an edge filter with every operator — each
 *      driven by local predicate state instead of the singleton
 *      ``searchStore``, so the surfaces stay pixel-identical;
 *   3. the look — its label, colour and icon, and how it paints: a card's
 *      tint and frame, or a line's dash and width — shown before it is saved.
 *
 * Premium UX:
 *   - live preview-as-you-build (debounced match count) + an explicit
 *     refresh affordance,
 *   - colour + Lucide-icon picker so chips can carry an icon,
 *   - duplicate-name guard, inline validation,
 *   - keyboard support (Esc cancels, ⌘/Ctrl+Enter saves).
 */
import { Check, Loader2, Spline, Tags, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { formatShortcut } from '@/lib/platform'
import { cn, generateId } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules } from '@/services/ruleCounts'
import type { DisplayRuleConfig, DisplayRuleStyle, DisplayRuleTarget } from '@/types/schema'
import { Segmented } from '@/components/ui/Segmented'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import type { EdgesPredicate, Predicate } from '@/types/search'

import { dashArrayOf, RULE_LINE_WIDTH } from '../ruleLines'
import { useDiscovery } from '../search/builder/useDiscovery'
import { fieldClass } from '../search/builder/editors/shared'
import { ConnectionBuilder } from '../search/panel/ConnectionBuilder'
import { hasIncompleteLeaf, isRowIncomplete } from '../search/panel/ConditionRow'
import { asDraft } from '../search/panel/findMode'
import { topLevelConditions } from '../search/panel/predicateComposition'
import { RelationProvider } from '../search/panel/RelationshipEditor'
import { VisualQueryBuilder } from '../search/panel/VisualQueryBuilder'

import { RuleChipRow } from './DisplayRuleTagChips'


/** Curated swatch palette — premium, legible-on-dark tag colors. */
const SWATCHES = [
    '#6366f1', // indigo
    '#3b82f6', // blue — "these are the starting points"
    '#06b6d4', // cyan
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#ec4899', // pink
    '#8b5cf6', // violet
    '#14b8a6', // teal
    '#64748b', // slate — "these are the ordinary ones", for a quiet tint
]

type FrameChoice = 'none' | 'solid' | 'dashed'
const FRAME_OPTIONS = [
    { value: 'none', label: 'No frame' },
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
] as const

type DashChoice = NonNullable<DisplayRuleStyle['dash']>
const DASH_OPTIONS = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
] as const

/** A line's widths, in pixels: the middle one is a rule's when it names none. */
const WIDTHS = { thin: 1.5, regular: RULE_LINE_WIDTH, bold: 4 } as const
type WidthChoice = keyof typeof WIDTHS
const WIDTH_OPTIONS = [
    { value: 'thin', label: 'Thin' },
    { value: 'regular', label: 'Regular' },
    { value: 'bold', label: 'Bold' },
] as const

/** The width choice nearest ``width``: a rule saved with another keeps it until one is picked. */
function widthChoiceOf(width: number): WidthChoice {
    return width < 2 ? 'thin' : width < 3.25 ? 'regular' : 'bold'
}

/** The style an entity rule is saved with: only what differs from a chip alone. */
function styleOf(chip: boolean, fill: boolean, frame: FrameChoice): DisplayRuleStyle | undefined {
    if (chip && !fill && frame === 'none') return undefined
    return {
        ...(chip ? {} : { chip: false }),
        ...(fill ? { fill: true } : {}),
        ...(frame !== 'none' ? { frame } : {}),
    }
}

/** The style a relationship rule is saved with: only what differs from a solid
 *  line of the usual width, with its chip. */
function lineStyleOf(chip: boolean, dash: DashChoice, width: number): DisplayRuleStyle | undefined {
    if (chip && dash === 'solid' && width === RULE_LINE_WIDTH) return undefined
    return {
        ...(chip ? {} : { chip: false }),
        ...(dash !== 'solid' ? { dash } : {}),
        ...(width !== RULE_LINE_WIDTH ? { width } : {}),
    }
}

/** Small, business-friendly Lucide icon set for tag chips. */
const ICON_CHOICES = [
    'Tag', 'ShieldCheck', 'AlertTriangle', 'Star', 'Flag', 'Lock',
    'Eye', 'Database', 'Users', 'Sparkles', 'CircleDot', 'Bookmark',
]

/** Debounce (ms) for live preview-as-you-build. */
const PREVIEW_DEBOUNCE_MS = 500

/** Every link, until the condition says which: the relationship builder's start. */
const ANY_LINK: EdgesPredicate = { kind: 'edges' }

const stepTitle = 'block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted'


export interface DisplayRuleEditorProps {
    viewId: string
    /** Entity types known to the active view (drives EntityType editor). */
    knownEntityTypes: string[]
    /** Layer names from the view config (drives Layer editor). */
    knownLayers: string[]
    /** When editing an existing rule; omitted for a new rule. */
    rule?: DisplayRuleConfig
    /** Names already in use by OTHER enabled rules — drives the
     *  duplicate-name guard. */
    existingNames?: string[]
    /** Save the rule. A promise that rejects keeps the editor open with the
     *  reason shown (the server refused it: a taken name, say). */
    onSave: (rule: DisplayRuleConfig) => void | Promise<void>
    onCancel: () => void
}


export function DisplayRuleEditor({
    viewId, knownEntityTypes, knownLayers, rule, existingNames = [], onSave, onCancel,
}: DisplayRuleEditorProps) {
    const provider = useGraphProvider()
    const [target, setTarget] = useState<DisplayRuleTarget>(rule?.target ?? 'entities')
    const lines = target === 'relationships'
    const [name, setName] = useState(rule?.name ?? '')
    const [color, setColor] = useState(rule?.color ?? SWATCHES[0])
    const [icon, setIcon] = useState<string | undefined>(rule?.icon)
    // How it paints what it matches, besides (or instead of) its chip: a
    // card's tint and frame, or a line's dash and width.
    const [chip, setChip] = useState(rule?.style?.chip !== false)
    const [fill, setFill] = useState(!!rule?.style?.fill)
    const [frame, setFrame] = useState<FrameChoice>(rule?.style?.frame ?? 'none')
    const [dash, setDash] = useState<DashChoice>(rule?.style?.dash ?? 'solid')
    const [width, setWidth] = useState<number>(rule?.style?.width ?? RULE_LINE_WIDTH)
    // A rule with no chip, tint or frame would match and show nothing; a
    // line always shows its colour.
    const showsNothing = !lines && !chip && !fill && frame === 'none'
    const [previewCount, setPreviewCount] = useState<number | null>(null)
    // False while the count is still reading the view: the number so far.
    const [previewExact, setPreviewExact] = useState(true)
    const [isPreviewing, setIsPreviewing] = useState(false)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    // Empty id ⇒ a seeded "new" rule from the Properties tab (or the
    // Advanced-Search "Create rule" flow). Minted once, so a save retried
    // after a lost answer replaces the rule rather than adding it twice.
    const [ruleId] = useState(() => rule?.id || generateId('rule'))

    // Local predicate state seeded from the rule — one for each target, so
    // switching back finds the condition as it was left. The builders mutate
    // it via onSeed/onCommit; we don't need undo history here, so both write
    // straight to setState.
    const seeded = (rule?.predicate as Predicate | null | undefined) ?? null
    const [predicate, setPredicate] = useState<Predicate | null>(
        rule?.target === 'relationships' ? null : seeded,
    )
    const [linePredicate, setLinePredicate] = useState<EdgesPredicate>(() => {
        // Kept as the server keeps it: a Connections search in an AND group of its own.
        const held = rule?.target === 'relationships' && seeded ? asDraft(seeded) : null
        return held?.kind === 'edges' ? held : ANY_LINK
    })
    const seedLines = (next: Predicate) => { if (next.kind === 'edges') setLinePredicate(next) }

    const {
        allKeys, keysByEntityType, tagValues, getValueSamples, suggestValues,
        edgeTypes, keysByEdgeType, getEdgeValueSamples, edgeKeyStoredAs,
    } = useDiscovery(viewId)
    const discovery = useMemo(
        () => ({ allKeys, keysByEntityType, tagValues, getValueSamples, suggestValues }),
        [allKeys, keysByEntityType, tagValues, getValueSamples, suggestValues],
    )
    const edgeDiscovery = useMemo(
        () => ({ edgeTypes, keysByEdgeType, getEdgeValueSamples, edgeKeyStoredAs }),
        [edgeTypes, keysByEdgeType, getEdgeValueSamples, edgeKeyStoredAs],
    )

    // Layer names → picker options. Memoised so the builder's row props stay
    // referentially stable across keystrokes.
    const layerOptions = useMemo(
        () => knownLayers.map((l) => ({ value: l, label: l })),
        [knownLayers],
    )

    const conditions = useMemo(() => topLevelConditions(predicate), [predicate])
    // No backend Cypher exists for an incomplete row (empty value / missing
    // key); block preview + save until every row is complete.
    const isEmpty = lines ? false : conditions.length === 0
    const hasIncomplete = lines ? linesUnfinished(linePredicate) : conditions.some((c) => isRowIncomplete(c))
    const asked: Predicate | null = lines ? linePredicate : predicate

    // Duplicate-name guard — case-insensitive against OTHER rules.
    const trimmedName = name.trim()
    const isDuplicate = useMemo(
        () => existingNames.some((n) => n.toLowerCase() === trimmedName.toLowerCase()),
        [existingNames, trimmedName],
    )
    const canSave = trimmedName.length > 0 && !isEmpty && !hasIncomplete && !isDuplicate && !showsNothing && !saving

    // ── Live preview-as-you-build ────────────────────────────────────
    // Count the condition's matches in the view (debounced) whenever it
    // changes, exactly — the count shows what it has found while it reads a
    // large view. The explicit "Refresh" button forces an immediate re-run.
    const treeKey = JSON.stringify(asked)
    const runPreview = useMemo(() => {
        return async (signal?: AbortSignal) => {
            if (!asked || isEmpty || hasIncomplete
                || !(provider instanceof RemoteGraphProvider)) {
                setPreviewCount(null)
                return
            }
            setIsPreviewing(true)
            setPreviewError(null)
            // Never show the last criteria's count as this one's.
            setPreviewCount(null)
            try {
                const counts = await countRules(provider, viewId, [{ id: 'preview', predicate: asked }], {
                    signal,
                    onUpdate: (update) => {
                        const c = update.get('preview')
                        if (signal?.aborted || !c) return
                        setPreviewCount(c.count)
                        setPreviewExact(c.complete)
                        setPreviewError(c.error ?? null)
                    },
                })
                if (signal?.aborted) return
                const final = counts.get('preview')
                setPreviewCount(final?.count ?? 0)
                setPreviewExact(true)
                if (final?.error) setPreviewError(final.error)
            } catch (e) {
                if (signal?.aborted) return
                setPreviewError((e as Error).message)
                setPreviewCount(null)
            } finally {
                if (!signal?.aborted) setIsPreviewing(false)
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, viewId, treeKey, isEmpty, hasIncomplete])

    useEffect(() => {
        const controller = new AbortController()
        const t = setTimeout(() => void runPreview(controller.signal), PREVIEW_DEBOUNCE_MS)
        return () => { controller.abort(); clearTimeout(t) }
    }, [runPreview])

    const handleSave = async () => {
        if (!canSave || !asked) return
        setSaving(true)
        setSaveError(null)
        try {
            await onSave({
                id: ruleId,
                name: trimmedName,
                color,
                icon,
                // Strip the FE-only ``uiScope`` hint that the flat builder
                // attaches to ``descendantOf`` rows so it never leaks into
                // the persisted blueprint.
                predicate: stripUiScope(asked),
                enabled: rule?.enabled ?? true,
                createdAt: rule?.createdAt ?? new Date().toISOString(),
                style: lines ? lineStyleOf(chip, dash, width) : styleOf(chip, fill, frame),
                // An entity rule says nothing: it is stored as every rule was.
                ...(lines ? { target: 'relationships' as const } : {}),
            })
        } catch (e) {
            setSaveError((e as Error).message)
        } finally {
            setSaving(false)
        }
    }

    // Keyboard: Esc cancels, ⌘/Ctrl+Enter saves.
    const rootRef = useRef<HTMLDivElement>(null)
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSave() }
    }

    const noun = lines
        ? (previewCount === 1 ? 'relationship will be styled' : 'relationships will be styled')
        : (previewCount === 1 ? 'entity will be tagged' : 'entities will be tagged')

    return (
        <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-5">
            {/* 1 — what the rule applies to. */}
            <Step n={1} title="Applies to">
                <TargetChoice value={target} onChange={setTarget} />
            </Step>

            {/* 2 — the condition, in the builder of what it applies to, and how many it matches. */}
            <Step n={2} title={lines ? 'Apply to relationships where…' : 'Apply this tag to entities where…'}>
                {lines ? (
                    // A rule is asked of every relationship on the canvas: its
                    // ends follow lineage one hop, as an entity rule does.
                    <RelationProvider rule viewId={viewId} edges={edgeDiscovery}>
                        <ConnectionBuilder
                            value={linePredicate}
                            onSeed={seedLines}
                            onCommit={seedLines}
                            viewId={viewId}
                            discovery={discovery}
                            knownEntityTypes={knownEntityTypes}
                            discoveredLayers={layerOptions}
                            isRunning={false}
                            onSubmit={() => void runPreview()}
                        />
                    </RelationProvider>
                ) : (
                    // A rule follows lineage one hop: it is asked of every entity on the canvas.
                    <RelationProvider rule viewId={viewId} edges={edgeDiscovery}>
                        <VisualQueryBuilder
                            predicate={predicate}
                            onSeed={setPredicate}
                            onCommit={setPredicate}
                            discovery={discovery}
                            knownEntityTypes={knownEntityTypes}
                            discoveredLayers={layerOptions}
                            onSubmit={() => void runPreview()}
                        />
                    </RelationProvider>
                )}

                {/* Live preview row */}
                <div className="flex items-center justify-between gap-2 min-h-[28px]">
                    <div className="text-[11px] text-ink-muted tabular-nums flex items-center gap-1.5">
                        {isPreviewing && previewCount === null ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Previewing…</>
                        ) : previewError ? (
                            <span className="text-rose-400 truncate max-w-[220px]">{previewError}</span>
                        ) : previewCount !== null ? (
                            <>
                                <span
                                    className="inline-block w-2 h-2 rounded-full"
                                    style={{ backgroundColor: color }}
                                />
                                <span className="text-ink font-semibold">{previewCount.toLocaleString()}</span>
                                {!previewExact ? 'found so far…' : noun}
                                {isPreviewing && <Loader2 className="w-3 h-3 animate-spin" />}
                            </>
                        ) : isEmpty ? (
                            <span className="text-ink-muted/60">Add a condition to preview matches</span>
                        ) : lines && hasIncomplete ? (
                            <span className="text-ink-muted/60">
                                Say which relationships — an end, their types or what they hold
                            </span>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={() => void runPreview()}
                        disabled={isEmpty || hasIncomplete || isPreviewing}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0',
                            (isEmpty || hasIncomplete)
                                ? 'text-ink-muted/40 cursor-not-allowed'
                                : 'text-accent-lineage hover:bg-accent-lineage/15',
                        )}
                    >
                        Refresh
                    </button>
                </div>
            </Step>

            {/* 3 — the look: the tag's label, colour and icon, and how it paints. */}
            <Step n={3} title="Look">
                <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2">
                        {/* Live chip preview */}
                        <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium shrink-0 max-w-[42%] truncate"
                            style={{ backgroundColor: `${color}26`, color }}
                            title={trimmedName || 'Tag preview'}
                        >
                            {icon && <DynamicIcon name={icon} className="w-3 h-3 shrink-0" />}
                            <span className="truncate">{trimmedName || 'Tag'}</span>
                        </span>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={lines
                                ? 'e.g. PII, Needs owner, Streaming feed'
                                : 'e.g. PII, Needs owner, Gold-certified'}
                            aria-label="Tag label"
                            className={fieldClass}
                        />
                    </div>
                    {isDuplicate && (
                        <span className="text-[11px] text-amber-400">
                            A rule named “{trimmedName}” already exists — pick a unique name.
                        </span>
                    )}
                    {/* Colour swatches */}
                    <div className="flex items-center gap-1.5">
                        {SWATCHES.map((sw) => (
                            <button
                                key={sw}
                                type="button"
                                onClick={() => setColor(sw)}
                                aria-label={`Use color ${sw}`}
                                className={cn(
                                    'w-6 h-6 rounded-lg transition-all',
                                    color === sw
                                        ? 'ring-2 ring-offset-2 ring-offset-canvas-elevated scale-110'
                                        : 'hover:scale-105 opacity-80 hover:opacity-100',
                                )}
                                style={{ backgroundColor: sw, ...(color === sw ? { boxShadow: `0 0 0 2px ${sw}` } : {}) }}
                            />
                        ))}
                    </div>
                    {/* Icon picker */}
                    <div className="flex items-center gap-1 flex-wrap">
                        <HoverTip label="Show the tag without an icon" className="inline-flex">
                            <button
                                type="button"
                                onClick={() => setIcon(undefined)}
                                className={cn(
                                    'w-7 h-7 rounded-lg flex items-center justify-center text-[10px] transition-all',
                                    !icon ? 'ring-2 ring-accent-lineage/60 text-ink' : 'text-ink-muted hover:bg-glass/40',
                                )}
                            >
                                None
                            </button>
                        </HoverTip>
                        {ICON_CHOICES.map((ic) => (
                            <button
                                key={ic}
                                type="button"
                                onClick={() => setIcon(ic)}
                                aria-label={`Use icon ${ic}`}
                                className={cn(
                                    'w-7 h-7 rounded-lg flex items-center justify-center transition-all',
                                    icon === ic
                                        ? 'ring-2 ring-accent-lineage/60'
                                        : 'hover:bg-glass/40',
                                )}
                                style={icon === ic ? { color } : undefined}
                            >
                                <DynamicIcon name={ic} className="w-3.5 h-3.5" />
                            </button>
                        ))}
                    </div>
                </div>

                {lines ? (
                    <>
                        {/* A line as it will be drawn, between two cards. */}
                        <LinePreview color={color} dash={dash} width={width} chip={chip}
                                     name={trimmedName} icon={icon} />
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[12px] text-ink">Line</span>
                            <Segmented label="Line" options={DASH_OPTIONS} value={dash} onChange={setDash} />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[12px] text-ink">Width</span>
                            <Segmented label="Width" options={WIDTH_OPTIONS} value={widthChoiceOf(width)}
                                       onChange={(w) => setWidth(WIDTHS[w])} />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <label htmlFor="rule-show-chip" className="text-[12px] text-ink cursor-pointer">Show the tag chip on the line</label>
                            <ToggleSwitch id="rule-show-chip" size="sm" checked={chip} onChange={setChip} aria-label="Show the tag chip on the line" />
                        </div>
                        <span className="text-[11px] leading-snug text-ink-muted">
                            Every matching rule adds its chip. Where two rules style the same line, the
                            one higher in the list gives its colour, line and width.
                        </span>
                    </>
                ) : (
                    <>
                        {/* What the rule does to the cards it matches, beside its
                            chip: a tint, a frame, or both; the chip can go. Shown on
                            a card as it will be drawn. */}
                        <div className="rounded-xl border border-glass-border bg-canvas p-3">
                            <div
                                data-testid="rule-look-preview"
                                className="flex items-center gap-2.5 rounded-xl border border-glass-border px-3 py-2.5 shadow-sm"
                                style={{
                                    backgroundColor: fill ? `color-mix(in srgb, ${color} 14%, var(--nx-bg-canvas))` : 'var(--nx-bg-canvas)',
                                    ...(frame !== 'none' && { outline: `2px ${frame} ${color}`, outlineOffset: -2 }),
                                }}
                            >
                                <span className="h-6 w-6 shrink-0 rounded-lg bg-accent-lineage/15" aria-hidden />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12.5px] font-medium text-ink">Customer Orders</span>
                                    {chip && (
                                        <span className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                                              style={{ backgroundColor: `${color}26`, color }}>
                                            {icon && <DynamicIcon name={icon} className="w-2.5 h-2.5 shrink-0" />}
                                            {trimmedName || 'Tag'}
                                        </span>
                                    )}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <label htmlFor="rule-show-chip" className="text-[12px] text-ink cursor-pointer">Show the tag chip</label>
                            <ToggleSwitch id="rule-show-chip" size="sm" checked={chip} onChange={setChip} aria-label="Show the tag chip" />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <label htmlFor="rule-fill" className="text-[12px] text-ink cursor-pointer">Colour the card</label>
                            <ToggleSwitch id="rule-fill" size="sm" checked={fill} onChange={setFill} aria-label="Colour the card" />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[12px] text-ink">Frame</span>
                            <Segmented label="Frame" options={FRAME_OPTIONS} value={frame} onChange={setFrame} />
                        </div>
                        {showsNothing && (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400">
                                Turn on the chip, a tint or a frame — otherwise the rule shows nothing.
                            </span>
                        )}
                        <span className="text-[11px] leading-snug text-ink-muted">
                            Every matching rule adds its chip. Where two rules colour or frame the same card, the
                            one higher in the list wins.
                        </span>
                    </>
                )}
            </Step>

            {saveError && (
                <p role="alert" className="text-[11px] text-rose-400 leading-snug">
                    Couldn't save the rule — {saveError}
                </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1 border-t border-glass-border/50">
                <button
                    type="button"
                    onClick={onCancel}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-glass/40 hover:text-ink transition-colors"
                >
                    <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <HoverTip label="Save the rule to this view" shortcut={formatShortcut('mod+enter')} className="inline-flex">
                    <button
                        type="button"
                        onClick={() => void handleSave()}
                        disabled={!canSave}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                            canSave
                                ? 'bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30'
                                : 'bg-glass/30 text-ink-muted/40 cursor-not-allowed',
                        )}
                    >
                        <Check className="w-3.5 h-3.5" /> {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
                    </button>
                </HoverTip>
            </div>
        </div>
    )
}


/** One step of the editor: its number, what it asks, and its controls. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
    return (
        <section aria-label={title} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
                <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-lineage/15 text-[10px] font-semibold tabular-nums text-accent-lineage">
                    {n}
                </span>
                <h3 className={stepTitle}>{title}</h3>
            </div>
            {children}
        </section>
    )
}


const TARGETS: { value: DisplayRuleTarget; title: string; detail: string; icon: typeof Tags }[] = [
    { value: 'entities', title: 'Entities', detail: 'Tag, tint or frame the cards that match', icon: Tags },
    { value: 'relationships', title: 'Relationships', detail: 'Colour, dash or widen the lines that match', icon: Spline },
]

/** What a rule applies to: two cards, one picked — a radio group. */
function TargetChoice({ value, onChange }: { value: DisplayRuleTarget; onChange: (v: DisplayRuleTarget) => void }) {
    const refs = useRef<Array<HTMLButtonElement | null>>([])
    const move = (e: KeyboardEvent, at: number) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault()
        const to = 1 - at
        onChange(TARGETS[to].value)
        refs.current[to]?.focus()
    }
    return (
        <div role="radiogroup" aria-label="What this rule applies to" className="grid grid-cols-2 gap-2">
            {TARGETS.map((t, i) => {
                const on = t.value === value
                const Icon = t.icon
                return (
                    <button
                        key={t.value}
                        ref={(el) => { refs.current[i] = el }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        onClick={() => onChange(t.value)}
                        onKeyDown={(e) => move(e, i)}
                        className={cn(
                            'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            on
                                ? 'border-accent-lineage/50 bg-accent-lineage/[0.08] shadow-sm shadow-accent-lineage/10'
                                : 'border-glass-border bg-canvas-elevated/30 hover:border-accent-lineage/30 hover:bg-glass/30',
                        )}
                    >
                        <span className={cn(
                            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                            on ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.04] text-ink-muted dark:bg-white/[0.06]',
                        )}>
                            <Icon className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-[12.5px] font-semibold text-ink">{t.title}</span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">{t.detail}</span>
                        </span>
                    </button>
                )
            })}
        </div>
    )
}


/** A relationship rule's line as the canvas will draw it: between two cards,
 *  in the rule's colour, dash and width, its chip at the middle. */
function LinePreview({ color, dash, width, chip, name, icon }: {
    color: string
    dash: DashChoice
    width: number
    chip: boolean
    name: string
    icon?: string
}) {
    const arrow = useId()
    const card = 'shrink-0 rounded-lg border border-glass-border bg-canvas-elevated px-2.5 py-1.5 text-[11.5px] font-medium text-ink shadow-sm'
    return (
        <div className="rounded-xl border border-glass-border bg-canvas p-3">
            <div className="relative flex items-center">
                <span className={card}>Orders</span>
                <svg aria-hidden className="h-8 min-w-0 flex-1 overflow-visible">
                    <defs>
                        <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8"
                                markerUnits="userSpaceOnUse" orient="auto">
                            <path d="M0,1 L9,5 L0,9 z" fill={color} />
                        </marker>
                    </defs>
                    <line
                        data-testid="rule-line-preview"
                        x1="4" y1="50%" x2="96%" y2="50%"
                        stroke={color} strokeWidth={width}
                        strokeDasharray={dashArrayOf(dash === 'solid' ? undefined : dash, width)}
                        strokeLinecap={dash === 'dotted' ? 'round' : undefined}
                        markerEnd={`url(#${arrow})`}
                    />
                </svg>
                <span className={card}>Revenue report</span>
                {chip && (
                    // On the canvas's own colour, so the line stops at the chip, as it does there.
                    <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-canvas">
                        <RuleChipRow tags={[{ id: 'preview', name: name || 'Tag', color, icon }]} size="xs" />
                    </span>
                )}
            </div>
        </div>
    )
}


/** Whether a relationship rule's condition is unfinished: relationship types
 *  to name and none named, an end half filled in, or nothing yet that says
 *  which relationships — no end, no types, no class and no filter. */
function linesUnfinished(p: EdgesPredicate): boolean {
    return p.edgeTypes?.length === 0
        || [p.sourceWhere, p.targetWhere].some((w) => !!w && hasIncompleteLeaf(w))
        || (!p.sourceWhere && !p.targetWhere && !p.edgeTypes?.length && !p.edgeClass && !p.edgePredicate)
}


/**
 * Recursively drop the FE-only ``uiScope`` hint that the flat builder
 * attaches to ``descendantOf`` rows (it routes the roots-only vs
 * any-node picker) — a Connections search's at either end too. The wire /
 * persisted predicate should be plain ``descendantOf`` so the saved
 * blueprint carries no UI-only fields.
 */
function stripUiScope(p: Predicate): Predicate {
    if (p.kind === 'group') {
        return { ...p, children: p.children.map(stripUiScope) }
    }
    if (p.kind === 'edges') {
        return {
            ...p,
            ...(p.sourceWhere ? { sourceWhere: stripUiScope(p.sourceWhere) } : {}),
            ...(p.targetWhere ? { targetWhere: stripUiScope(p.targetWhere) } : {}),
        }
    }
    if (p.kind === 'descendantOf') {
        const rest = { ...p } as Predicate & { uiScope?: unknown }
        delete rest.uiScope
        return rest as Predicate
    }
    return p
}
