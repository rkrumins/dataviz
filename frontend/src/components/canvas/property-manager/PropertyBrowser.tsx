/**
 * PropertyBrowser — the Properties tab: every property the view's entities
 * carry, read from every entity in the view (the property catalog,
 * ``usePropertyCatalog``) — on how many, stored as which kinds, with which
 * values — and the bulk property changes staged against them.
 *
 * Nothing here is sampled. A count is a number of entities; a value list is
 * every value while a key has at most a thousand distinct ones — past that
 * the key is high-cardinality, and says so. While a large view is still
 * being read, the tab shows what has been read so far and how far the read
 * has got.
 *
 * Lifecycle operations are staged IN-SESSION (``propertyDraftStore``) and
 * surfaced optimistically over the catalogue — there is no backend
 * node-property write yet, so the copy makes clear nothing is persisted.
 */
import { motion } from 'framer-motion'
import {
    AlertTriangle, ArrowDownWideNarrow, ChevronRight, CircleSlash, Copy, Database, Layers, Loader2,
    Pencil, Plus, ScanSearch, Search, Sparkles, Tag, Tags, Trash2, Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import {
    usePropertyCatalogOverlay, usePropertyDraftStore, usePropertyOps,
    type CatalogOverlayEntry, type PropertyOp,
} from '@/store/propertyDraftStore'
import type { Predicate, SearchCatalogProperty, SearchCatalogValue } from '@/types/search'

import { fieldClass } from '../search/builder/editors/shared'

import { PropertyInsightsHeader } from './PropertyInsightsHeader'
import { PropertyOperationDialog, type PropertyDialogMode } from './PropertyOperationDialog'
import { RankedValueBars, UsageGauge } from './PropertyInsightCharts'
import { EntityTypeChips, SampleValueChips, TypeTile } from './PropertyValueChips'
import { KIND_LABEL, storedType } from './propertyValueTypes'


export interface PropertyBrowserProps {
    viewId: string
    knownEntityTypes: string[]
    knownLayers: string[]
    onCreateRuleFromPredicate: (predicate: Predicate, suggestedName: string) => void
    /** Open + run a predicate in the Advanced Search panel (canvas-owned). */
    onSearchPredicate?: (predicate: Predicate) => void
}

/** A bound "search this in Advanced Search" callback passed to rows. */
export type SearchHandler = (predicate: Predicate, label: string) => void

type DialogState = { mode: PropertyDialogMode; key?: string } | null
type SortMode = 'usage' | 'name'

/** Rows drawn at first, and added per "Show more" — a view can carry
 *  thousands of keys. */
const ROWS_PAGE = 100


export function PropertyBrowser({
    viewId, knownEntityTypes, knownLayers, onCreateRuleFromPredicate, onSearchPredicate,
}: PropertyBrowserProps) {
    const { notify } = useAppNotifications()
    // Open + run a constructed predicate in the real Advanced Search panel.
    const search: SearchHandler | undefined = useMemo(() => {
        if (!onSearchPredicate) return undefined
        return (predicate, label) => {
            onSearchPredicate(predicate)
            notify('info', `Searching ${label} in Advanced Search`)
        }
    }, [onSearchPredicate, notify])
    const copyKey = (key: string) => {
        void navigator.clipboard?.writeText(key)
            .then(() => notify('success', `Copied “${key}”`))
            .catch(() => notify('error', `Couldn't copy “${key}”`))
    }

    const { catalog, reading, error, unavailable, refresh } = usePropertyCatalog(viewId)
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<SortMode>('usage')
    const [dialog, setDialog] = useState<DialogState>(null)
    const [shown, setShown] = useState(ROWS_PAGE)

    const pendingOps = usePropertyOps()
    const overlay = usePropertyCatalogOverlay()

    const properties = useMemo(() => catalog?.properties ?? [], [catalog])
    const tags = useMemo(() => catalog?.tags ?? [], [catalog])
    const entities = catalog?.entities ?? 0

    const knownKeys = useMemo(() => new Set(properties.map((p) => p.key)), [properties])
    const pendingNewKeys = useMemo(
        () => [...overlay.keys()].filter(
            (k) => !knownKeys.has(k) && (overlay.get(k)!.kinds.has('set') || overlay.get(k)!.kinds.has('fillEmpty')),
        ).sort(),
        [overlay, knownKeys],
    )
    // The value a staged-new property will be set to (for its preview chip).
    const stagedValueByKey = useMemo(() => {
        const m = new Map<string, string>()
        for (const op of pendingOps) {
            if ((op.kind === 'set' || op.kind === 'fillEmpty') && op.value !== undefined && !m.has(op.key)) {
                m.set(op.key, String(op.value))
            }
        }
        return m
    }, [pendingOps])

    const q = query.trim().toLowerCase()
    // The catalog lists keys most-carried first; A–Z is the other order.
    const listed = useMemo(() => {
        const base = q ? properties.filter((p) => p.key.toLowerCase().includes(q)) : properties
        return sort === 'name' ? [...base].sort((a, b) => a.key.localeCompare(b.key)) : base
    }, [properties, q, sort])
    const filteredNewKeys = useMemo(
        () => (q ? pendingNewKeys.filter((k) => k.toLowerCase().includes(q)) : pendingNewKeys),
        [pendingNewKeys, q],
    )
    const filteredTags = useMemo(
        () => (q ? tags.filter((t) => t.tag.toLowerCase().includes(q)) : tags),
        [tags, q],
    )

    const dialogEl = dialog && (
        <PropertyOperationDialog
            viewId={viewId}
            mode={dialog.mode}
            initialKey={dialog.key}
            knownEntityTypes={knownEntityTypes}
            knownLayers={knownLayers}
            onClose={() => setDialog(null)}
        />
    )

    if (unavailable) {
        return (
            <div className="px-3 py-5 rounded-xl border border-glass-border text-center text-[11px] text-ink-muted">
                Property insights aren't available for this view here.
            </div>
        )
    }
    if (!catalog) {
        return error ? (
            <div className="flex flex-col gap-2 px-3 py-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
                <span>Couldn't read this view's properties — {error}</span>
                <button type="button" onClick={refresh} className="self-start underline hover:text-rose-200">
                    Try again
                </button>
            </div>
        ) : (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-[11px] text-ink-muted">
                <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Reading every entity in this view…
                </span>
                <ProgressBar value={reading ?? 0} label="Reading every entity in this view" className="w-40" />
            </div>
        )
    }

    const nothingFound = catalog.status === 'complete' && properties.length === 0
        && tags.length === 0 && pendingNewKeys.length === 0

    if (nothingFound) {
        return (
            <div className="flex flex-col gap-3">
                {pendingOps.length > 0 && <PendingChanges ops={pendingOps} />}
                <EmptyHero onNew={() => setDialog({ mode: 'create' })} />
                {dialogEl}
            </div>
        )
    }

    const rows = listed.slice(0, shown)

    return (
        <div className="flex flex-col gap-3">
            <PropertyInsightsHeader catalog={catalog} reading={reading} error={error} onRefresh={refresh} />

            {pendingOps.length > 0 && <PendingChanges ops={pendingOps} />}

            {/* Toolbar: filter + sort + New */}
            <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setShown(ROWS_PAGE) }}
                        placeholder="Filter properties and tags…"
                        aria-label="Filter properties and tags"
                        className={cn(fieldClass, 'pl-9')}
                    />
                </div>
                <SortToggle sort={sort} onChange={setSort} />
                <button
                    type="button"
                    onClick={() => setDialog({ mode: 'create' })}
                    title="Define a new property and apply it to matched entities"
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-9 rounded-lg text-[12px] font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" /> New
                </button>
            </div>

            {/* Properties */}
            {(listed.length > 0 || filteredNewKeys.length > 0) && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Database className="w-3 h-3" /> Properties · {(listed.length + filteredNewKeys.length).toLocaleString()}
                    </h4>
                    <div className="flex flex-col gap-1.5">
                        {filteredNewKeys.map((key) => (
                            <PendingNewRow
                                key={`new-${key}`}
                                propertyKey={key}
                                stagedValue={stagedValueByKey.get(key)}
                                onUpdate={() => setDialog({ mode: 'update', key })}
                                onRemove={() => setDialog({ mode: 'remove', key })}
                                onCreateRule={() => onCreateRuleFromPredicate({ kind: 'hasProperty', key, negate: false }, key)}
                            />
                        ))}
                        {rows.map((property) => (
                            <PropertyRow
                                key={property.key}
                                property={property}
                                entities={entities}
                                exact={catalog.status === 'complete'}
                                onSearch={search}
                                overlay={overlay.get(property.key)}
                                onUpdate={() => setDialog({ mode: 'update', key: property.key })}
                                onRemove={() => setDialog({ mode: 'remove', key: property.key })}
                                onCreateRule={() => onCreateRuleFromPredicate(
                                    { kind: 'hasProperty', key: property.key, negate: false }, property.key)}
                                onCopy={() => copyKey(property.key)}
                            />
                        ))}
                    </div>
                    {listed.length > rows.length && (
                        <button
                            type="button"
                            onClick={() => setShown((n) => n + ROWS_PAGE)}
                            className="self-center mt-1 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40 transition-colors"
                        >
                            Show {Math.min(ROWS_PAGE, listed.length - rows.length).toLocaleString()} more
                            {' '}of {(listed.length - rows.length).toLocaleString()}
                        </button>
                    )}
                </section>
            )}

            {/* Tags */}
            {filteredTags.length > 0 && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Tag className="w-3 h-3" /> Tags · {filteredTags.length.toLocaleString()}
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                        {filteredTags.map(({ tag, count }) => (
                            <button
                                key={tag}
                                type="button"
                                onClick={() => onCreateRuleFromPredicate({ kind: 'tag', op: 'hasAny', values: [tag] }, tag)}
                                title={`Create a display rule tagging the ${count.toLocaleString()} entities tagged "${tag}"`}
                                className="group inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20 transition-colors"
                            >
                                {tag}
                                <span className="text-[10px] tabular-nums text-accent-lineage/70">{count.toLocaleString()}</span>
                                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                        ))}
                    </div>
                </section>
            )}

            {listed.length === 0 && filteredNewKeys.length === 0 && filteredTags.length === 0 && (
                <div className="px-3 py-5 text-center text-[11px] text-ink-muted">
                    {q ? <>Nothing matches <span className="font-mono text-ink">{query}</span>.</>
                        : 'No properties read yet.'}
                </div>
            )}

            {dialogEl}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Sort toggle (segmented)
// ---------------------------------------------------------------------------

function SortToggle({ sort, onChange }: { sort: SortMode; onChange: (s: SortMode) => void }) {
    return (
        <div className="shrink-0 inline-flex rounded-lg p-0.5 bg-canvas-base border border-glass-border">
            {(['usage', 'name'] as SortMode[]).map((s) => (
                <button
                    key={s}
                    type="button"
                    onClick={() => onChange(s)}
                    title={s === 'name' ? 'Sort A–Z' : 'Sort by how many entities carry it'}
                    aria-pressed={sort === s}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 h-8 rounded-md text-[11px] font-medium transition-colors',
                        sort === s ? 'bg-accent-lineage/20 text-accent-lineage' : 'text-ink-muted hover:text-ink',
                    )}
                >
                    {s === 'name' ? 'A–Z' : <><ArrowDownWideNarrow className="w-3 h-3" /> Most used</>}
                </button>
            ))}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Empty / first-run hero
// ---------------------------------------------------------------------------

function EmptyHero({ onNew }: { onNew: () => void }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
                'relative overflow-hidden rounded-2xl p-5 flex flex-col items-center text-center gap-3',
                'bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated/30 to-purple-500/[0.06]',
                'border border-glass-border/60',
            )}
        >
            <div className="pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full bg-accent-lineage/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-16 -left-12 w-44 h-44 rounded-full bg-purple-500/8 blur-3xl" />
            <div className="relative w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-br from-accent-lineage/35 to-cyan-500/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                <Sparkles className="w-6 h-6 text-accent-lineage" />
            </div>
            <div className="relative">
                <div className="text-[15px] font-display font-semibold text-ink">Manage properties for this view</div>
                <p className="mt-1 text-[12px] text-ink-muted leading-snug max-w-[280px]">
                    Define a property and roll it out to every matched entity, audit how existing
                    ones are used, and clean up in bulk. Changes stage in-session — nothing is saved yet.
                </p>
            </div>
            <button
                type="button"
                onClick={onNew}
                className="relative inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[12.5px] font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors"
            >
                <Plus className="w-4 h-4" /> Create your first property
            </button>
        </motion.div>
    )
}


// ---------------------------------------------------------------------------
// Pending changes review
// ---------------------------------------------------------------------------

function opSummary(op: PropertyOp): string {
    const n = `${op.targetCount} ${op.targetCount === 1 ? 'entity' : 'entities'}`
    switch (op.kind) {
        case 'set': return `Set ${op.key} = ${String(op.value)} · ${n}`
        case 'fillEmpty': return `Fill ${op.key} (if empty) = ${String(op.value)} · ${n}`
        case 'rename': return `Rename ${op.key} → ${op.newKey} · ${n}`
        case 'remove': return `Remove ${op.key} · ${n}`
    }
}

function PendingChanges({ ops }: { ops: PropertyOp[] }) {
    const [open, setOpen] = useState(false)
    const removeOp = usePropertyDraftStore((s) => s.removeOp)
    const clearOps = usePropertyDraftStore((s) => s.clearOps)

    const rollup = useMemo(() => {
        const counts: Record<string, number> = {}
        let entities = 0
        for (const op of ops) { counts[op.kind] = (counts[op.kind] ?? 0) + 1; entities += op.targetCount }
        const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`)
        return { parts, entities }
    }, [ops])

    return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 overflow-hidden">
            <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
                <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="flex-1 min-w-0 text-[11.5px] text-amber-100/90 leading-tight">
                    <span className="font-semibold">{ops.length} staged change{ops.length === 1 ? '' : 's'}</span>
                    {' '}— in-session only, not saved to the graph
                </span>
                <ChevronRight className={cn('w-3.5 h-3.5 text-amber-300/80 shrink-0 transition-transform', open && 'rotate-90')} />
            </button>
            {open && (
                <div className="px-2 pb-2 flex flex-col gap-1 border-t border-amber-500/20 pt-1.5">
                    <div className="px-2 text-[10px] text-amber-200/70">
                        Would {rollup.parts.join(' · ')} across ~{rollup.entities} {rollup.entities === 1 ? 'entity' : 'entities'}.
                    </div>
                    {ops.map((op) => (
                        <div key={op.id} className="group flex items-center gap-2 px-2 py-1 rounded-md hover:bg-amber-500/10">
                            <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-amber-100/90" title={opSummary(op)}>
                                {opSummary(op)}
                            </span>
                            <button
                                type="button"
                                onClick={() => removeOp(op.id)}
                                title="Undo this staged change"
                                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-amber-300/70 hover:text-amber-100 hover:bg-amber-500/20 transition-colors"
                            >
                                <Undo2 className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                    <button type="button" onClick={clearOps} className="self-end mt-0.5 text-[10.5px] text-amber-300/80 hover:text-amber-100 transition-colors">
                        Discard all
                    </button>
                </div>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Property row (expandable: usage, kinds, range, values, actions)
// ---------------------------------------------------------------------------

/** How a value reads in a chip or a bar. A decimal that is a whole
 *  number keeps its point: 1.0 is not the integer 1. */
function valueText(v: SearchCatalogValue): string {
    if (typeof v.value === 'string') return v.value
    if (v.kind === 'Float' && Number.isInteger(v.value)) return `${v.value}.0`
    return JSON.stringify(v.value)
}

/** Each value's label — with its kind when two would otherwise read the
 *  same: the text "true" and the boolean true are two values. */
function valueLabels(values: SearchCatalogValue[]): string[] {
    const plain = values.map(valueText)
    const seen = new Map<string, number>()
    for (const text of plain) seen.set(text, (seen.get(text) ?? 0) + 1)
    return values.map((v, i) => (seen.get(plain[i])! > 1
        ? `${plain[i]} (${KIND_LABEL[v.kind] ?? v.kind})` : plain[i]))
}

/** ``key`` is ``value``, compared as the kind it is stored as. A list's
 *  element matches the lists holding it: list comparisons are
 *  element-wise. */
function valuePredicate(key: string, v: SearchCatalogValue): Predicate {
    const valueType = v.kind === 'Integer' || v.kind === 'Float' ? 'number'
        : v.kind === 'Boolean' ? 'boolean' : 'string'
    return { kind: 'property', key, op: 'eq', value: v.value, valueType } as Predicate
}

function PropertyRow({
    property, entities, exact, overlay, onUpdate, onRemove, onCreateRule, onCopy, onSearch,
}: {
    property: SearchCatalogProperty
    /** Entities in the view — what coverage is a share of. */
    entities: number
    /** The catalog is complete: its counts are exact, not "so far". */
    exact: boolean
    overlay?: CatalogOverlayEntry
    onUpdate: () => void
    onRemove: () => void
    onCreateRule: () => void
    onCopy: () => void
    onSearch?: SearchHandler
}) {
    const [expanded, setExpanded] = useState(false)
    const key = property.key
    const { type, mixed } = storedType(property.kinds)
    const byType = useMemo(
        () => Object.entries(property.byEntityType).sort((a, b) => b[1] - a[1]),
        [property.byEntityType],
    )
    const kinds = Object.entries(property.kinds).sort((a, b) => b[1] - a[1])
    const share = entities > 0 ? Math.min(100, Math.round((property.count / entities) * 100)) : 0
    const values = property.values
    const labels = useMemo(() => valueLabels(property.values), [property.values])
    // Labels are unique, so a clicked label names one value.
    const searchLabel = onSearch
        ? (label: string) => {
            const v = values[labels.indexOf(label)]
            if (v) onSearch(valuePredicate(key, v), `${key} = ${label}`)
        }
        : undefined
    const pendingRemove = overlay?.kinds.has('remove')

    return (
        <div className={cn(
            'group relative rounded-2xl border bg-canvas-elevated transition-all duration-200',
            pendingRemove ? 'border-rose-500/40 shadow-sm'
                : 'border-glass-border shadow-sm hover:shadow-md hover:-translate-y-px hover:border-accent-lineage/30',
        )}>
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
                className="flex items-start gap-3 px-3.5 py-3 cursor-pointer"
            >
                <TypeTile type={type} accent={pendingRemove ? 'rose' : undefined} />
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    {/* Title */}
                    <div className="flex items-center gap-2">
                        <span className={cn('font-mono text-[12.5px] truncate', pendingRemove ? 'text-rose-300 line-through' : 'text-ink')} title={key}>
                            {key}
                        </span>
                        {mixed && (
                            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border bg-amber-500/15 text-amber-300 border-amber-500/30">
                                <AlertTriangle className="w-2.5 h-2.5" /> mixed
                            </span>
                        )}
                        {overlay && (
                            <PendingBadge
                                label={pendingRemove ? 'remove' : overlay.kinds.has('rename') ? 'rename' : 'edit'}
                                tone={pendingRemove ? 'rose' : 'amber'}
                            />
                        )}
                        <div className="ml-auto shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                <RowAction icon={<Copy className="w-3 h-3" />} label="Copy the name" onClick={onCopy} />
                                <RowAction icon={<Pencil className="w-3 h-3" />} label="Update" onClick={onUpdate} />
                                <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger />
                                <RowAction icon={<Plus className="w-3 h-3" />} label="Create rule" onClick={onCreateRule} />
                            </div>
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg text-ink-muted group-hover:bg-glass transition-colors">
                                <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-90')} />
                            </span>
                        </div>
                    </div>

                    {/* Coverage: how many entities carry it, of the view */}
                    <div className="flex items-center gap-2 text-[10.5px] text-ink-muted tabular-nums">
                        <div className="w-16 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden shrink-0">
                            <div className="h-full rounded-full bg-accent-lineage" style={{ width: `${Math.max(2, share)}%` }} />
                        </div>
                        <span>
                            <span className="text-ink font-medium">{property.count.toLocaleString()}</span>
                            {exact ? '' : ' so far'} · {share}%
                        </span>
                        <span className="text-ink-muted">·</span>
                        <span>
                            {property.distinctExact
                                ? `${property.distinct.toLocaleString()} ${property.distinct === 1 ? 'value' : 'values'}`
                                : `${property.distinct.toLocaleString()}+ values`}
                        </span>
                    </div>

                    {/* Used by */}
                    {byType.length > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-ink-muted min-w-0">
                            <span className="shrink-0">Used by</span>
                            <EntityTypeChips types={byType.map(([t]) => t)} />
                        </div>
                    )}

                    {/* The values most held */}
                    {values.length > 0 && (
                        <SampleValueChips values={labels} onValueClick={searchLabel} />
                    )}
                </div>
            </div>

            {expanded && (
                <div className="px-4 pb-3.5 pl-[3.75rem] border-t border-glass-border pt-3 flex flex-col gap-4">
                    {/* Quick actions — construct + run a query in Advanced Search,
                        or tag matches as a display rule. */}
                    <div className="flex flex-wrap gap-2">
                        {onSearch && (
                            <>
                                <QuickActionCard
                                    icon={<ScanSearch className="w-3.5 h-3.5" />}
                                    label="Find all using this"
                                    onClick={() => onSearch({ kind: 'hasProperty', key, negate: false } as Predicate, `entities using ${key}`)}
                                />
                                <QuickActionCard
                                    icon={<CircleSlash className="w-3.5 h-3.5" />}
                                    label="Find missing this"
                                    onClick={() => onSearch({ kind: 'hasProperty', key, negate: true } as Predicate, `entities missing ${key}`)}
                                />
                            </>
                        )}
                        <QuickActionCard
                            icon={<Tags className="w-3.5 h-3.5" />}
                            label="Tag matches as rule"
                            tone="accent"
                            onClick={onCreateRule}
                        />
                    </div>

                    <UsageGauge
                        total={property.count}
                        viewTotal={entities}
                        byEntityType={byType.map(([t, count]) => ({ type: t, count }))}
                        onTypeClick={onSearch ? (t) => onSearch(
                            { kind: 'group', op: 'and', children: [
                                { kind: 'hasProperty', key, negate: false },
                                { kind: 'entityType', op: 'in', values: [t] },
                            ] } as Predicate,
                            `${key} on ${t}`,
                        ) : undefined}
                    />

                    {mixed && (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-snug">
                            Stored as {kinds.map(([kind, n], i) => (
                                <span key={kind}>
                                    {i > 0 && (i === kinds.length - 1 ? ' and ' : ', ')}
                                    <span className="font-semibold">{KIND_LABEL[kind] ?? kind}</span>
                                    {' '}on {n.toLocaleString()}
                                </span>
                            ))} entities. A search compares each kind as its own — pick the kind you mean.
                        </div>
                    )}

                    {property.min !== undefined && property.min !== null && (
                        <div className="text-[11px] text-ink-muted">
                            Numbers from <span className="font-mono text-ink">{String(property.min)}</span>
                            {' '}to <span className="font-mono text-ink">{String(property.max)}</span>
                        </div>
                    )}

                    {values.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                                {property.distinct > values.length
                                    ? `The ${values.length} most held of ${property.distinct.toLocaleString()} values`
                                    : 'Values'}
                            </div>
                            <RankedValueBars
                                items={values.map((v, i) => ({ label: labels[i], count: v.count }))}
                                total={property.count}
                                limit={values.length}
                                onItemClick={searchLabel ? (it) => searchLabel(it.label) : undefined}
                            />
                        </div>
                    ) : (
                        <p className="text-[11px] text-ink-muted leading-snug">
                            More than {property.distinct.toLocaleString()} distinct values — too many to list,
                            every one still searchable.
                        </p>
                    )}

                    {property.residual > 0 && (
                        <p className="text-[11px] text-amber-300 leading-snug">
                            {property.residual.toLocaleString()} {property.residual === 1 ? 'entity holds' : 'entities hold'} it
                            past the graph's native-property budget — search doesn't read those yet.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}


/** A property staged in this session that no entity carries yet. */
function PendingNewRow({
    propertyKey, stagedValue, onUpdate, onRemove, onCreateRule,
}: {
    propertyKey: string
    stagedValue?: string
    onUpdate: () => void
    onRemove: () => void
    onCreateRule: () => void
}) {
    return (
        <div className="group relative rounded-2xl border border-emerald-500/40 bg-canvas-elevated shadow-sm">
            <div className="flex items-start gap-3 px-3.5 py-3">
                <TypeTile type={null} accent="emerald" />
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] truncate text-ink" title={propertyKey}>{propertyKey}</span>
                        <PendingBadge label="new" tone="emerald" />
                        <div className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            <RowAction icon={<Pencil className="w-3 h-3" />} label="Update" onClick={onUpdate} />
                            <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger />
                            <RowAction icon={<Plus className="w-3 h-3" />} label="Create rule" onClick={onCreateRule} />
                        </div>
                    </div>
                    {stagedValue !== undefined && stagedValue !== '' && <SampleValueChips values={[stagedValue]} />}
                </div>
            </div>
        </div>
    )
}


function PendingBadge({ label, tone }: { label: string; tone: 'emerald' | 'amber' | 'rose' }) {
    const tones = {
        emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
        rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    }
    return (
        <span className={cn('shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border', tones[tone])}>{label}</span>
    )
}

function RowAction({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={label}
            aria-label={label}
            className={cn(
                'inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors',
                danger ? 'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10' : 'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
            )}
        >
            {icon}
        </button>
    )
}


/** Premium quick-action card in a property's expanded panel. */
function QuickActionCard({
    icon, label, onClick, tone,
}: {
    icon: React.ReactNode
    label: string
    onClick: () => void
    tone?: 'accent'
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-medium transition-all',
                tone === 'accent'
                    ? 'border-accent-lineage/30 bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20'
                    : 'border-glass-border bg-canvas-base text-ink-secondary hover:text-ink hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.06]',
            )}
        >
            {icon}
            {label}
        </button>
    )
}
