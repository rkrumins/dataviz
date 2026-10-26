/**
 * AddFilterPalette — the single discoverable way to add a new filter
 * row to the Query card.
 *
 *   [+ Add filter…]   →    ┌─ palette popover ─────────────────╮
 *                          │ 🔍 type to filter, or paste DSL…  │
 *                          │ ─────────────────────────────────│
 *                          │ TEXT                              │
 *                          │   ⌕ Name contains…                │
 *                          │   ⌕ Description contains…         │
 *                          │ STRUCTURE                         │
 *                          │   ◇ Type is (4 in this view)      │
 *                          │   ⌬ Layer is (3 in this view)     │
 *                          │ TAGS & PROPERTIES                 │
 *                          │   # Tag is (12 discovered)        │
 *                          │   ⚑ Has property (37 keys)        │
 *                          │   ⊜ Property compares to…         │
 *                          │ GRAPH SHAPE                       │
 *                          │   ↑ No upstream lineage           │
 *                          │   ↓ No downstream lineage         │
 *                          │   ⊘ No lineage edges              │
 *                          │ ADVANCED                          │
 *                          │   ⤇ Path between A and B          │
 *                          │   ⊕ OR / NOT group                │
 *                          ╰───────────────────────────────────╯
 *
 * Two ways to use it:
 *   1) Click a category entry → emits ONE empty predicate of that kind,
 *      the QueryCard inserts it as a new (incomplete) row.
 *   2) Paste a DSL fragment into the search input → the palette runs
 *      ``parsePredicate`` on it and offers "Add N filters from … "; on
 *      click, emits the full parsed predicate.
 *
 * The palette never touches the draft itself — it just emits predicates.
 * The parent (QueryCard) decides how to integrate them.
 */
import { motion } from 'framer-motion'
import { Plus, Search, Sparkles } from 'lucide-react'
import {
    type FC,
    memo,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { parsePredicate, stringifyPredicate } from './predicateDsl'
import { topLevelConditions } from './predicateComposition'
import { RelationContext } from './relationContext'
import {
    availableCategories as kindsAvailable,
    ICON_TONES,
    type CodeKind,
    type FilterKind,
} from './vocabulary/filterKinds'


/** The condition kinds with no visual editor (kept exported here for the
 *  builders that name it by this module). */
export type { CodeKind }


export interface AddFilterPaletteProps {
    /** Discovery telemetry for the count chips shown in entries. */
    counts: {
        entityTypes: number
        tags: number
        propertyKeys: number
        layers: number
    }
    /** Discovery samples surfaced inline under each entry as small
     *  preview chips ("Try: rowCount, owner, layerAssignment…").
     *  Turns the count chip from a bare number into actionable
     *  guidance — the user sees WHAT they can filter on, not just
     *  "11 keys exist". Each list is already ordered by discovery
     *  frequency (most-used first) so the first 3-4 chips are the
     *  highest-signal previews. */
    samples?: {
        entityTypes?: ReadonlyArray<string>
        tags?: ReadonlyArray<string>
        propertyKeys?: ReadonlyArray<string>
        layers?: ReadonlyArray<string>
    }
    /** Emit one new predicate to add (and run). The QueryCard will
     *  splice it into the AND group via ``upsertCondition``. */
    onAdd: (predicate: Predicate) => void
    /** Emit a list of predicates to add at once (from DSL paste). */
    onAddMany: (predicates: Predicate[]) => void
    /** Open Advanced for group / path authoring. Omit (e.g. the Property
     *  Manager rule editor, which has no Advanced drawer) to drop any
     *  ``action:'advanced'`` entries from the palette. */
    onOpenAdvanced?: () => void
    /** Open the Code (JSON) editor with a stub of the named predicate
     *  kind appended to the current draft. Used by the "Code-only"
     *  Advanced entries (withinHops, degree) — visual editors for
     *  these shapes don't exist; the user authors them in JSON instead.
     *  Omit to drop those entries (no Code mode in the rule editor). */
    onOpenCode?: (kind: CodeKind) => void
    disabled?: boolean
}


/** Per-entry visual identity. ``icon`` is a Lucide component so the
 *  palette reads as part of the same icon language the canvas + the
 *  templates use — not ASCII chars in a circle (the previous look
 *  felt placeholder). ``tone`` keys into ICON_TONES below to give
 *  each category a distinct accent (text → cyan, structure →
 *  emerald, etc.) instead of every row being the same lineage purple. */
type PaletteEntry = FilterKind & {
    count?: number
    /** Sample values rendered as small chips below the description.
     *  Up to ~4 are surfaced; the rest fold into a "+N more" chip. */
    samples?: ReadonlyArray<string>
}


const AddFilterPaletteImpl: FC<AddFilterPaletteProps> = ({
    counts, samples, onAdd, onAddMany, onOpenAdvanced, onOpenCode, disabled,
}) => {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    // How many relationships this builder's conditions sit inside, and
    // whether it is a display rule's (a rule tests one entity: no routes).
    const { depth: relationDepth, rule } = useContext(RelationContext)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)

    // Measure the trigger button on open / scroll / resize so the portal
    // popover stays anchored. Using a portal escapes the panel's
    // overflow-clip + stacking-context constraints (the previous in-tree
    // popover bled through the results section because the parent
    // scroll container clipped it and `/98` opacity let underlying
    // content show through).
    useLayoutEffect(() => {
        if (!open) { setCoords(null); return }
        const update = () => {
            const r = buttonRef.current?.getBoundingClientRect()
            if (!r) return
            // Anchor under the QueryCard content area so the popover
            // fills the full panel width instead of looking squashed
            // at a hardcoded 320px. We walk up from the trigger to
            // the nearest panel-content container (sentinel attr set
            // by QueryCard); fall back to the button's positioned
            // parent when the sentinel isn't found (e.g. when the
            // palette mounts in a non-panel context). Clamp to
            // [320, 640] so it never collapses on a thin sidebar and
            // never grows wider than usable form-row width.
            const sentinel = buttonRef.current?.closest<HTMLElement>(
                '[data-search-panel-content]',
            )
            const containerRect = sentinel?.getBoundingClientRect()
            const popoverW = Math.max(
                320,
                Math.min(640, containerRect?.width ?? 320),
            )
            const viewportW = window.innerWidth
            // Anchor to the LEFT edge of the panel container so the
            // popover starts where the form rows start (visually
            // consistent), not under the small "Add filter" button.
            const left = Math.min(
                containerRect?.left ?? r.left,
                viewportW - popoverW - 8,
            )
            setCoords({ top: r.bottom + 4, left, width: popoverW })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [open])

    // Live DSL preview: if the user has typed something that parses to
    // one or more conditions, we surface them as a "Paste 2 filters"
    // affordance at the top of the menu.
    const dslPreview = useMemo(() => {
        const trimmed = query.trim()
        if (!trimmed) return null
        const parsed = parsePredicate(trimmed)
        if (!parsed.predicate) return null
        const conditions = topLevelConditions(parsed.predicate)
        if (conditions.length === 0) return null
        // Skip the preview when the only thing parsed is a bareword
        // fallback (substring text on name) — the regular Text entry
        // covers that already.
        if (
            conditions.length === 1
            && parsed.recognized.length === 0
            && parsed.fallbackText.length > 0
        ) {
            return null
        }
        return {
            conditions,
            recognized: parsed.recognized.length,
            preview: stringifyPredicate(parsed.predicate),
        }
    }, [query])

    // The catalog (vocabulary/filterKinds) says what can be added and where;
    // the palette adds this view's counts and samples to it. Entries whose
    // hand-off isn't wired here drop out: ``code`` entries need
    // ``onOpenCode``, ``advanced`` ones ``onOpenAdvanced`` (the Property
    // Manager's rule editor has neither, so group authoring there goes
    // through the AND/OR/NOT-group entries).
    const availableCategories = useMemo<{
        label: string
        entries: PaletteEntry[]
    }[]>(() => kindsAvailable({
        relationDepth, rule, canCode: !!onOpenCode, canAdvanced: !!onOpenAdvanced,
    }).map((cat) => ({
        label: cat.label,
        entries: cat.entries.map((e): PaletteEntry => (e.countKey
            ? { ...e, count: counts[e.countKey], samples: samples?.[e.countKey] }
            : e)),
    })), [counts, samples, onOpenCode, onOpenAdvanced, relationDepth, rule])

    const filteredCategories = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return availableCategories
        return availableCategories
            .map((cat) => ({
                ...cat,
                entries: cat.entries.filter((e) =>
                    e.label.toLowerCase().includes(q)
                    || (e.description?.toLowerCase().includes(q) ?? false),
                ),
            }))
            .filter((cat) => cat.entries.length > 0)
    }, [availableCategories, query])

    // Close on outside click + Escape. Includes the portal-rendered
    // popover in the "inside" check so clicks within it don't dismiss.
    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node
            if (wrapperRef.current?.contains(t)) return
            if (popoverRef.current?.contains(t)) return
            setOpen(false)
            setQuery('')
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setOpen(false); setQuery('') }
        }
        document.addEventListener('mousedown', onDocClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 30)
    }, [open])

    const handleEntry = useCallback((entry: PaletteEntry) => {
        if (entry.action === 'advanced') {
            onOpenAdvanced?.()
        } else if (entry.action === 'code' && entry.codeKind) {
            onOpenCode?.(entry.codeKind)
        } else if (entry.build) {
            onAdd(entry.build({ rule }))
        }
        setOpen(false)
        setQuery('')
    }, [onAdd, onOpenAdvanced, onOpenCode])

    const handlePasteDsl = useCallback(() => {
        if (!dslPreview) return
        onAddMany(dslPreview.conditions)
        setOpen(false)
        setQuery('')
    }, [dslPreview, onAddMany])

    const popover = open && coords ? (
        <>
            {/* No AnimatePresence: the popover unmounts instantly on close so an
                interrupted exit can never strand an invisible click-blocker at
                z-1000 over the toolbar. It still animates in. */}
            <motion.div
                ref={popoverRef}
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.12 }}
                style={{
                    position: 'fixed',
                    top: coords.top,
                    left: coords.left,
                    width: coords.width,
                    zIndex: 9999,
                }}
                className={cn(
                    'rounded-xl border border-glass-border',
                    // Fully opaque background — the previous /98 let the
                    // results section visibly bleed through. Use the raw
                    // canvas-elevated token plus a heavy shadow for depth.
                    'bg-canvas-elevated',
                    'shadow-2xl shadow-black/50',
                    'flex flex-col overflow-hidden',
                )}
            >
                {/* Search / DSL paste input — visual style aligned
                    with the ContextViewHeader's premium "Search
                    visible entities…" input so both inputs read as
                    the same control family. Layered gradient fill +
                    accent focus ring + slightly larger 13.5px text. */}
                <div className="relative px-3 pt-3 pb-2 border-b border-glass-border/60">
                    <div className="relative group">
                        {/* Soft accent halo on focus */}
                        <div
                            aria-hidden
                            className={cn(
                                "absolute -inset-px rounded-[12px] pointer-events-none",
                                "bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0",
                                "group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15",
                                "group-focus-within:blur-[8px]",
                                "transition-all duration-300",
                            )}
                        />
                        <Search
                            className={cn(
                                "absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] pointer-events-none",
                                "text-ink-muted/55 group-focus-within:text-accent-lineage",
                                "group-hover:text-ink-muted/80",
                                "transition-colors duration-200",
                            )}
                            strokeWidth={2.2}
                        />
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Filter — or paste DSL like tag:PII noUpstream"
                            className={cn(
                                "relative w-full pl-10 pr-3 py-2.5 rounded-[11px]",
                                "text-[13.5px] text-ink placeholder:text-ink-muted/45",
                                "bg-gradient-to-b from-black/[0.03] to-black/[0.05]",
                                "dark:from-white/[0.04] dark:to-white/[0.025]",
                                "border border-black/[0.08] dark:border-white/[0.08]",
                                "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                                "hover:border-black/[0.14] dark:hover:border-white/[0.14]",
                                "focus:outline-none",
                                "focus:border-accent-lineage/55 focus:ring-2 focus:ring-accent-lineage/20",
                                "focus:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]",
                                "transition-all duration-200",
                            )}
                        />
                    </div>
                </div>

                {/* DSL paste preview */}
                {dslPreview && (
                    <button
                        type="button"
                        onClick={handlePasteDsl}
                        className={cn(
                            'flex items-start gap-2 px-2.5 py-2 text-left',
                            'bg-accent-lineage/10 hover:bg-accent-lineage/15',
                            'border-b border-glass-border/60',
                            'transition-colors',
                        )}
                    >
                        <Sparkles className="w-3.5 h-3.5 mt-0.5 text-accent-lineage shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="text-[11.5px] font-medium text-accent-lineage">
                                Add {dslPreview.conditions.length} filter{dslPreview.conditions.length === 1 ? '' : 's'} from DSL
                            </div>
                            <div className="text-[10.5px] text-ink-muted/80 font-mono truncate">
                                {dslPreview.preview}
                            </div>
                        </div>
                    </button>
                )}

                {/* Categories.
                    Sized up from the cramped 12/10.5px reading the
                    user flagged. With the popover now 380-640px
                    wide (W2 UX uplift) there's room for legible
                    text + a more generous row rhythm. */}
                <div className="max-h-[32rem] overflow-y-auto custom-scrollbar py-1.5">
                    {filteredCategories.length === 0 ? (
                        <div className="px-4 py-5 text-[12.5px] text-ink-muted/80 italic">
                            No filters match &ldquo;{query}&rdquo;.
                        </div>
                    ) : (
                        filteredCategories.map((cat) => (
                            <div key={cat.label} className="mb-1.5">
                                <div className={cn(
                                    'px-4 pt-2.5 pb-1.5 text-[10.5px] font-mono uppercase',
                                    'tracking-[0.18em] text-ink-muted/65 font-semibold',
                                )}>
                                    {cat.label}
                                </div>
                                {cat.entries.map((entry) => {
                                    const tone = ICON_TONES[entry.tone ?? 'group']
                                    const IconComponent = entry.icon
                                    return (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => handleEntry(entry)}
                                        className={cn(
                                            'group/row w-full flex items-start gap-3 px-4 py-2.5',
                                            'text-left transition-colors',
                                            'hover:bg-accent-lineage/[0.08]',
                                            'focus:outline-none focus:bg-accent-lineage/[0.10]',
                                        )}
                                    >
                                        <span className={cn(
                                            'shrink-0 w-8 h-8 rounded-lg border',
                                            'flex items-center justify-center',
                                            'shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
                                            'transition-transform group-hover/row:scale-[1.04]',
                                            tone.container,
                                        )}>
                                            <IconComponent
                                                className={cn('w-4 h-4', tone.icon)}
                                                strokeWidth={2.2}
                                            />
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-[13.5px] text-ink font-semibold">
                                                    {entry.label}
                                                </span>
                                                {typeof entry.count === 'number' && (
                                                    <span className="text-[11px] text-ink-muted/80 tabular-nums">
                                                        ({entry.count.toLocaleString()})
                                                    </span>
                                                )}
                                            </div>
                                            {entry.description && (
                                                <div className="text-[12px] text-ink-muted/85 leading-snug mt-0.5">
                                                    {entry.description}
                                                </div>
                                            )}
                                            {entry.samples && entry.samples.length > 0 && (
                                                <SampleChips samples={entry.samples} />
                                            )}
                                        </div>
                                    </button>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>
            </motion.div>
        </>
    ) : null

    return (
        <div ref={wrapperRef} className="relative inline-block">
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
                    'text-[11.5px] font-medium transition-all border border-dashed',
                    open
                        ? 'border-accent-lineage/60 bg-accent-lineage/10 text-accent-lineage'
                        : 'border-glass-border text-ink-secondary hover:text-ink hover:border-accent-lineage/40 hover:bg-accent-lineage/8',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
            >
                <Plus className="w-3.5 h-3.5" />
                Add filter
            </button>
            {typeof document !== 'undefined' && popover
                ? createPortal(popover, document.body)
                : null}
        </div>
    )
}


/**
 * Memoised so the palette (which rebuilds its category catalogue + a
 * portal) doesn't re-render on every keystroke in a sibling filter row.
 * VisualQueryBuilder passes referentially stable counts/samples/callbacks.
 */
export const AddFilterPalette = memo(AddFilterPaletteImpl)


/**
 * Sample-value preview chips rendered under category entries
 * (Entity type, Layer, Tag, Has property, Property compares to).
 *
 * Discovery sources order their values by frequency, so the first
 * few entries are the highest-signal preview — exactly what a user
 * needs to recognise "oh, the graph has ``layerAssignment`` and
 * ``rowCount`` props" without having to click into the field.
 * Chips past the visible cap fold into a ``+N more`` chip so the
 * row stays one-line-tall on narrow viewports.
 */
function SampleChips({ samples }: { samples: ReadonlyArray<string> }) {
    const VISIBLE_CAP = 5
    const visible = samples.slice(0, VISIBLE_CAP)
    const remainder = samples.length - visible.length
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {visible.map((s) => (
                <span
                    key={s}
                    title={s}
                    className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md',
                        'text-[11px] leading-tight font-mono',
                        'text-accent-lineage/90',
                        'bg-accent-lineage/[0.10]',
                        'border border-accent-lineage/20',
                        'max-w-[18ch] truncate',
                    )}
                >
                    {s}
                </span>
            ))}
            {remainder > 0 && (
                <span
                    className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-md',
                        'text-[11px] leading-tight font-mono tabular-nums font-semibold',
                        'text-ink-muted/80 bg-black/[0.04] dark:bg-white/[0.05]',
                        'border border-black/[0.06] dark:border-white/[0.08]',
                    )}
                >
                    +{remainder}
                </span>
            )}
        </div>
    )
}
