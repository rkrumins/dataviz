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
import { AnimatePresence, motion } from 'framer-motion'
import {
    AlignLeft,
    Boxes,
    Equal,
    Flag,
    GitMerge,
    Hash,
    KeyRound,
    GitBranch,
    Layers,
    Milestone,
    Parentheses,
    Plus,
    Radar,
    Route,
    Search,
    Share2,
    Sparkles,
    Tag,
    Type,
    Unplug,
    type LucideIcon,
} from 'lucide-react'
import {
    type FC,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import type { Predicate, EdgeClass } from '@/types/search'

import { parsePredicate, stringifyPredicate } from './predicateDsl'
import { topLevelConditions } from './predicateComposition'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


/**
 * Per-category icon accents. The Add Filter palette previously
 * rendered every entry with the same lineage-purple ASCII glyph,
 * which made the categories visually indistinguishable. Tying each
 * category to a curated accent gives the palette a typed taxonomy
 * the user reads at a glance — text rows pulse cyan, structure
 * emerald, governance amber, lineage rose, and so on — matching the
 * "premium / modern" UX bar of the template picker.
 */
type IconTone =
    | 'text'
    | 'structure'
    | 'governance'
    | 'lineage-missing'   // negative — "no X" rows
    | 'lineage-present'   // positive — "has X" rows
    | 'group'

const ICON_TONES: Record<IconTone, { container: string; icon: string }> = {
    text: {
        container: 'bg-sky-500/[0.10] border-sky-500/25 dark:bg-sky-500/[0.14]',
        icon: 'text-sky-600 dark:text-sky-400',
    },
    structure: {
        container: 'bg-emerald-500/[0.10] border-emerald-500/25 dark:bg-emerald-500/[0.14]',
        icon: 'text-emerald-600 dark:text-emerald-400',
    },
    governance: {
        container: 'bg-amber-500/[0.10] border-amber-500/30 dark:bg-amber-500/[0.14]',
        icon: 'text-amber-700 dark:text-amber-300',
    },
    // Negative lineage signal (no upstream / no downstream / orphan).
    // Rose reads as "warning / gap" so a user scanning the palette
    // doesn't confuse "no upstream" (these are sources) with
    // "has upstream" (these are sinks).
    'lineage-missing': {
        container: 'bg-rose-500/[0.10] border-rose-500/25 dark:bg-rose-500/[0.14]',
        icon: 'text-rose-600 dark:text-rose-400',
    },
    // Positive lineage signal (has upstream / has downstream).
    // Teal sits between the structure-emerald and the text-sky so
    // it reads as connected-data without clashing with either.
    'lineage-present': {
        container: 'bg-teal-500/[0.10] border-teal-500/25 dark:bg-teal-500/[0.14]',
        icon: 'text-teal-600 dark:text-teal-400',
    },
    group: {
        container: 'bg-violet-500/[0.10] border-violet-500/25 dark:bg-violet-500/[0.14]',
        icon: 'text-violet-600 dark:text-violet-400',
    },
}


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
    /** Open Advanced for group / path authoring. */
    onOpenAdvanced: () => void
    /** Open the Code (JSON) editor with a stub of the named predicate
     *  kind appended to the current draft. Used by the "Code-only"
     *  Advanced entries (path, withinHops) — visual editors for these
     *  shapes don't exist; the user authors them in JSON instead. */
    onOpenCode: (kind: 'path' | 'withinHops') => void
    disabled?: boolean
}


/** Per-entry visual identity. ``icon`` is a Lucide component so the
 *  palette reads as part of the same icon language the canvas + the
 *  templates use — not ASCII chars in a circle (the previous look
 *  felt placeholder). ``tone`` keys into ICON_TONES below to give
 *  each category a distinct accent (text → cyan, structure →
 *  emerald, etc.) instead of every row being the same lineage purple. */
interface PaletteEntry {
    id: string
    icon: LucideIcon
    tone?: IconTone
    label: string
    description?: string
    count?: number
    /** Sample values rendered as small chips below the description.
     *  Up to ~4 are surfaced; the rest fold into a "+N more" chip. */
    samples?: ReadonlyArray<string>
    /** Row action:
     *    - ``emit``: build a predicate and add it to the query.
     *    - ``advanced``: open the Advanced drawer (groups, options).
     *    - ``code``: open the JSON editor with a stub of ``codeKind``
     *      appended to the current draft (path / withinHops). */
    action: 'emit' | 'advanced' | 'code'
    build?: () => Predicate
    codeKind?: 'path' | 'withinHops'
}


export const AddFilterPalette: FC<AddFilterPaletteProps> = ({
    counts, samples, onAdd, onAddMany, onOpenAdvanced, onOpenCode, disabled,
}) => {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
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

    const categories = useMemo<{
        label: string
        entries: PaletteEntry[]
    }[]>(() => [
        {
            label: 'Text',
            entries: [
                {
                    id: 'text-name',
                    icon: Type, tone: 'text',
                    label: 'Name contains…',
                    description: 'Substring match against the display name',
                    action: 'emit',
                    build: () => ({
                        kind: 'text', value: '', target: 'name',
                        match: 'substring', caseSensitive: false, boost: 1.0,
                    }),
                },
                {
                    id: 'text-qname',
                    icon: Hash, tone: 'text',
                    label: 'Qualified name contains…',
                    description: 'Match against the fully-qualified name',
                    action: 'emit',
                    build: () => ({
                        kind: 'text', value: '', target: 'qualifiedName',
                        match: 'substring', caseSensitive: false, boost: 1.0,
                    }),
                },
                {
                    id: 'text-desc',
                    icon: AlignLeft, tone: 'text',
                    label: 'Description contains…',
                    description: 'Match against the entity description',
                    action: 'emit',
                    build: () => ({
                        kind: 'text', value: '', target: 'description',
                        match: 'substring', caseSensitive: false, boost: 1.0,
                    }),
                },
            ],
        },
        {
            label: 'Structure',
            entries: [
                {
                    id: 'entity-type',
                    icon: Boxes, tone: 'structure',
                    label: 'Entity type is…',
                    description: 'Restrict to specific node types',
                    count: counts.entityTypes,
                    samples: samples?.entityTypes,
                    action: 'emit',
                    build: () => ({
                        kind: 'entityType', op: 'in', values: [],
                    }),
                },
                {
                    id: 'root-in-view',
                    icon: Layers, tone: 'structure',
                    label: 'Root in view is…',
                    description:
                        'Restrict to entities under one of the view\'s '
                        + 'top-level containers (e.g. SILVER, GOLD, a '
                        + 'top-level Layer). The simple, common case — '
                        + 'pick from the same containers visible at the '
                        + 'top of the canvas tree.',
                    count: counts.layers,
                    samples: samples?.layers,
                    action: 'emit',
                    // ``uiScope: 'roots'`` is the FE-only hint that
                    // routes ConditionRow to the roots-only picker.
                    // Stripped at the API boundary so the wire-format
                    // predicate is plain ``descendantOf``.
                    build: () => ({
                        kind: 'descendantOf', urns: [],
                        uiScope: 'roots',
                    } as Predicate),
                },
                {
                    id: 'inside-subtree',
                    icon: GitBranch, tone: 'structure',
                    label: 'Inside Subtree',
                    description:
                        'Restrict results to descendants of any node on '
                        + 'the canvas — Layer, Object, Container, or '
                        + 'deeper. Power-user isolation for searching '
                        + 'a specific section of the graph that isn\'t '
                        + 'a top-level root.',
                    action: 'emit',
                    build: () => ({
                        kind: 'descendantOf', urns: [],
                        uiScope: 'any',
                    } as Predicate),
                },
            ],
        },
        {
            label: 'Tags & properties',
            entries: [
                {
                    id: 'tag',
                    icon: Tag, tone: 'governance',
                    label: 'Tag is…',
                    description: 'Has one or more of the chosen tags',
                    count: counts.tags,
                    samples: samples?.tags,
                    action: 'emit',
                    build: () => ({
                        kind: 'tag', op: 'hasAny', values: [],
                    }),
                },
                {
                    id: 'has-property',
                    icon: KeyRound, tone: 'governance',
                    label: 'Has property…',
                    description: 'A given metadata key is set on the node',
                    count: counts.propertyKeys,
                    samples: samples?.propertyKeys,
                    action: 'emit',
                    build: () => ({
                        kind: 'hasProperty', key: '', negate: false,
                    }),
                },
                {
                    id: 'property',
                    icon: Equal, tone: 'governance',
                    label: 'Property compares to…',
                    description: 'Filter by property = / ≠ / > / < value',
                    count: counts.propertyKeys,
                    samples: samples?.propertyKeys,
                    action: 'emit',
                    build: () => ({
                        kind: 'property', key: '', op: 'eq', value: '',
                    }),
                },
            ],
        },
        {
            label: 'Graph shape',
            entries: [
                {
                    id: 'no-upstream',
                    icon: Milestone, tone: 'lineage-missing',
                    label: 'No upstream lineage',
                    description: 'Source nodes — nothing feeds them',
                    action: 'emit',
                    build: () => ({
                        kind: 'isRoot', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'no-downstream',
                    icon: Flag, tone: 'lineage-missing',
                    label: 'No downstream lineage',
                    description: 'Terminal nodes — nothing reads from them',
                    action: 'emit',
                    build: () => ({
                        kind: 'isLeaf', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'no-lineage',
                    icon: Unplug, tone: 'lineage-missing',
                    label: 'No lineage edges',
                    description: 'Disconnected nodes — no upstream AND no downstream',
                    action: 'emit',
                    build: () => ({
                        kind: 'isOrphan', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'has-upstream',
                    icon: GitMerge, tone: 'lineage-present',
                    label: 'Has upstream lineage',
                    description: 'Nodes fed by at least one source',
                    action: 'emit',
                    build: () => ({
                        kind: 'hasIncoming', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'has-downstream',
                    icon: Share2, tone: 'lineage-present',
                    label: 'Has downstream lineage',
                    description: 'Nodes that feed at least one consumer',
                    action: 'emit',
                    build: () => ({
                        kind: 'hasOutgoing', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
            ],
        },
        {
            label: 'Advanced',
            entries: [
                {
                    id: 'path',
                    icon: Route, tone: 'group',
                    label: 'Path from A to B',
                    description:
                        'Lineage paths between two URN sets — Code only. '
                        + 'Opens the JSON editor with a stub; fill in '
                        + 'sourceUrns and targetUrns.',
                    action: 'code',
                    codeKind: 'path',
                },
                {
                    id: 'within-hops',
                    icon: Radar, tone: 'group',
                    label: 'Within N hops of…',
                    description:
                        'N-hop neighbourhood of an anchor URN — Code only. '
                        + 'Opens the JSON editor with a stub; fill in '
                        + 'urns and hops.',
                    action: 'code',
                    codeKind: 'withinHops',
                },
                {
                    id: 'and-group',
                    icon: Parentheses, tone: 'group',
                    label: 'AND group',
                    description: 'Group of conditions where every child must match',
                    action: 'emit',
                    build: () => ({ kind: 'group', op: 'and', children: [] }),
                },
                {
                    id: 'or-group',
                    icon: Parentheses, tone: 'group',
                    label: 'OR group',
                    description: 'Group of conditions where at least one child must match',
                    action: 'emit',
                    build: () => ({ kind: 'group', op: 'or', children: [] }),
                },
                {
                    id: 'not-group',
                    icon: Parentheses, tone: 'group',
                    label: 'NOT group',
                    description: 'Invert the result of the wrapped condition',
                    action: 'emit',
                    build: () => ({ kind: 'group', op: 'not', children: [] }),
                },
            ],
        },
    ], [counts])

    const filteredCategories = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return categories
        return categories
            .map((cat) => ({
                ...cat,
                entries: cat.entries.filter((e) =>
                    e.label.toLowerCase().includes(q)
                    || (e.description?.toLowerCase().includes(q) ?? false),
                ),
            }))
            .filter((cat) => cat.entries.length > 0)
    }, [categories, query])

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
            onOpenAdvanced()
        } else if (entry.action === 'code' && entry.codeKind) {
            onOpenCode(entry.codeKind)
        } else if (entry.build) {
            onAdd(entry.build())
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
        <AnimatePresence>
            <motion.div
                ref={popoverRef}
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
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
        </AnimatePresence>
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
