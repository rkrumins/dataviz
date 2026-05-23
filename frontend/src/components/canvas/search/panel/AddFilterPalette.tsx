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
import { Plus, Search, Sparkles } from 'lucide-react'
import {
    type FC,
    type ReactNode,
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


export interface AddFilterPaletteProps {
    /** Discovery telemetry for the count chips shown in entries. */
    counts: {
        entityTypes: number
        tags: number
        propertyKeys: number
        layers: number
    }
    /** Emit one new predicate to add (and run). The QueryCard will
     *  splice it into the AND group via ``upsertCondition``. */
    onAdd: (predicate: Predicate) => void
    /** Emit a list of predicates to add at once (from DSL paste). */
    onAddMany: (predicates: Predicate[]) => void
    /** Open Advanced for group / path authoring. */
    onOpenAdvanced: () => void
    disabled?: boolean
}


interface PaletteEntry {
    id: string
    icon: ReactNode
    label: string
    description?: string
    count?: number
    /** Either emit a predicate (most rows) or trigger Advanced (paths/groups). */
    action: 'emit' | 'advanced'
    build?: () => Predicate
}


export const AddFilterPalette: FC<AddFilterPaletteProps> = ({
    counts, onAdd, onAddMany, onOpenAdvanced, disabled,
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
            const popoverW = 320
            const viewportW = window.innerWidth
            // Anchor to the bottom-left of the button; clamp so we don't
            // overflow the right edge of the viewport.
            const left = Math.min(r.left, viewportW - popoverW - 8)
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
                    icon: '⌕', label: 'Name contains…',
                    description: 'Substring match against the display name',
                    action: 'emit',
                    build: () => ({
                        kind: 'text', value: '', target: 'name',
                        match: 'substring', caseSensitive: false, boost: 1.0,
                    }),
                },
                {
                    id: 'text-qname',
                    icon: '⌕', label: 'Qualified name contains…',
                    description: 'Match against the fully-qualified name',
                    action: 'emit',
                    build: () => ({
                        kind: 'text', value: '', target: 'qualifiedName',
                        match: 'substring', caseSensitive: false, boost: 1.0,
                    }),
                },
                {
                    id: 'text-desc',
                    icon: '⌕', label: 'Description contains…',
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
                    icon: '◇', label: 'Entity type is…',
                    description: 'Restrict to specific node types',
                    count: counts.entityTypes,
                    action: 'emit',
                    build: () => ({
                        kind: 'entityType', op: 'in', values: [],
                    }),
                },
                {
                    id: 'layer',
                    icon: '⌬', label: 'Layer is…',
                    description: 'Filter by pipeline layer',
                    count: counts.layers,
                    action: 'emit',
                    build: () => ({
                        kind: 'layer', layerAssignment: '',
                    }),
                },
            ],
        },
        {
            label: 'Tags & properties',
            entries: [
                {
                    id: 'tag',
                    icon: '#', label: 'Tag is…',
                    description: 'Has one or more of the chosen tags',
                    count: counts.tags,
                    action: 'emit',
                    build: () => ({
                        kind: 'tag', op: 'hasAny', values: [],
                    }),
                },
                {
                    id: 'has-property',
                    icon: '⚑', label: 'Has property…',
                    description: 'A given metadata key is set on the node',
                    count: counts.propertyKeys,
                    action: 'emit',
                    build: () => ({
                        kind: 'hasProperty', key: '', negate: false,
                    }),
                },
                {
                    id: 'property',
                    icon: '⊜', label: 'Property compares to…',
                    description: 'Filter by property = / ≠ / > / < value',
                    count: counts.propertyKeys,
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
                    icon: '↑', label: 'No upstream lineage',
                    description: 'Nodes with no incoming lineage edges',
                    action: 'emit',
                    build: () => ({
                        kind: 'isRoot', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'no-downstream',
                    icon: '↓', label: 'No downstream lineage',
                    description: 'Nodes with no outgoing lineage edges',
                    action: 'emit',
                    build: () => ({
                        kind: 'isLeaf', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'no-lineage',
                    icon: '⊘', label: 'No lineage edges',
                    description: 'Disconnected nodes (no upstream and no downstream)',
                    action: 'emit',
                    build: () => ({
                        kind: 'isOrphan', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'has-upstream',
                    icon: '⇣', label: 'Has upstream lineage',
                    action: 'emit',
                    build: () => ({
                        kind: 'hasIncoming', edgeClass: DEFAULT_EDGE_CLASS,
                    }),
                },
                {
                    id: 'has-downstream',
                    icon: '⇡', label: 'Has downstream lineage',
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
                    icon: '⤇', label: 'Path from A to B',
                    description: 'Lineage paths between two URNs — opens Advanced',
                    action: 'advanced',
                },
                {
                    id: 'within-hops',
                    icon: '⇿', label: 'Within N hops of…',
                    description: 'N-hop neighbourhood of an anchor URN — opens Advanced',
                    action: 'advanced',
                },
                {
                    id: 'subtree',
                    icon: '⌂', label: 'Inside subtree…',
                    description: 'Limit to descendants of one or more URNs — opens Advanced',
                    action: 'advanced',
                },
                {
                    id: 'or-not',
                    icon: '⊕', label: 'OR / NOT group',
                    description: 'Compose with OR or NOT — opens Advanced',
                    action: 'advanced',
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
        } else if (entry.build) {
            onAdd(entry.build())
        }
        setOpen(false)
        setQuery('')
    }, [onAdd, onOpenAdvanced])

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
                {/* Search / DSL paste input */}
                <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-glass-border/60">
                    <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter — or paste DSL like tag:PII noUpstream"
                        className={cn(
                            'flex-1 bg-transparent text-[12px] text-ink',
                            'placeholder:text-ink-muted/60 focus:outline-none',
                        )}
                    />
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

                {/* Categories */}
                <div className="max-h-[28rem] overflow-y-auto custom-scrollbar py-1">
                    {filteredCategories.length === 0 ? (
                        <div className="px-3 py-4 text-[11px] text-ink-muted/80 italic">
                            No filters match "{query}".
                        </div>
                    ) : (
                        filteredCategories.map((cat) => (
                            <div key={cat.label} className="mb-1">
                                <div className={cn(
                                    'px-3 pt-2 pb-1 text-[9.5px] font-mono uppercase',
                                    'tracking-[0.16em] text-ink-muted/60',
                                )}>
                                    {cat.label}
                                </div>
                                {cat.entries.map((entry) => (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => handleEntry(entry)}
                                        className={cn(
                                            'w-full flex items-start gap-2 px-3 py-1.5',
                                            'text-left transition-colors',
                                            'hover:bg-glass/40',
                                        )}
                                    >
                                        <span className="text-[14px] text-accent-lineage leading-none mt-0.5 w-4 shrink-0 text-center">
                                            {entry.icon}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-[12px] text-ink font-medium">
                                                    {entry.label}
                                                </span>
                                                {typeof entry.count === 'number' && (
                                                    <span className="text-[10px] text-ink-muted tabular-nums">
                                                        ({entry.count.toLocaleString()})
                                                    </span>
                                                )}
                                            </div>
                                            {entry.description && (
                                                <div className="text-[10.5px] text-ink-muted/80 leading-snug">
                                                    {entry.description}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                ))}
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
