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
 * A property is changed in bulk — set, filled, renamed, copied, removed — through
 * the one guided dialog (``requestOp``), applied to the draft by a job on the
 * server; the draft's jobs are listed with how far each has got and what it
 * did, and their properties are marked in the list. Changes are offered only
 * where an entity edit could be kept, in a draft (``useEntityEditing``);
 * elsewhere they are disabled and say why. With several entities selected on
 * the canvas, it offers to compare and edit them in the entity drawer.
 *
 * "Make it a field…" promotes a property to a field of the entity types that carry it, in the
 * data source's semantic layer (``PromoteFieldDialog``) — offered to who may edit the layer.
 *
 * Its values are cleaned up the same way: **Clean up…** on a property, **Merge
 * similar values…** where values differ only in case or spaces, **Convert all
 * to …** where a property is stored as several kinds, and **Merge into…** for
 * values picked from its value bars.
 */
import { motion } from 'framer-motion'
import {
    AlertTriangle, ArrowDownWideNarrow, ArrowRightLeft, ChevronRight, CircleSlash, Combine, Copy, CopyPlus, Database, Layers, ListChecks, Loader2,
    Pencil, Plus, ScanSearch, Search, Sparkles, Tag, Tags, Trash2, WandSparkles,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { HoverTip } from '@/components/ui/HoverTip'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import { useEntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import { useSemanticLayerAccess } from '@/features/ontology/lib/useSemanticLayerAccess'
import { useCurrentBranchId, useGraphId } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import {
    useDraftPropertyJobs, usePropertyCatalogOverlay, usePropertyJobsStore, type CatalogOverlayEntry, type OpRequest,
} from '@/store/propertyJobsStore'
import type { ValueKind, ValueMapping } from '@/services/versioningApiService'
import type { Predicate, SearchCatalogProperty, SearchCatalogValue } from '@/types/search'

import { fieldClass } from '../search/builder/editors/shared'

import { similarGroups } from './op/cleanup'
import { PropertyInsightsHeader } from './PropertyInsightsHeader'
import { PropertyJobsPanel } from './PropertyJobsPanel'
import { PromoteFieldDialog } from './PromoteFieldDialog'
import { RankedValueBars, UsageGauge } from './PropertyInsightCharts'
import { EntityTypeChips, SampleValueChips, TypeTile } from './PropertyValueChips'
import { KIND_LABEL, storedType } from './propertyValueTypes'


export interface PropertyBrowserProps {
    viewId: string
    onCreateRuleFromPredicate: (predicate: Predicate, suggestedName: string) => void
    /** Open + run a predicate in the Advanced Search panel (canvas-owned). */
    onSearchPredicate?: (predicate: Predicate) => void
}

/** A bound "search this in Advanced Search" callback passed to rows. */
export type SearchHandler = (predicate: Predicate, label: string) => void

type SortMode = 'usage' | 'name'

/** Rows drawn at first, and added per "Show more" — a view can carry
 *  thousands of keys. */
const ROWS_PAGE = 100


export function PropertyBrowser({
    viewId, onCreateRuleFromPredicate, onSearchPredicate,
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
    const [shown, setShown] = useState(ROWS_PAGE)

    // The draft's bulk changes — running and ended — and what they do to each property.
    const jobs = useDraftPropertyJobs(useGraphId(), useCurrentBranchId())
    const overlay = usePropertyCatalogOverlay(jobs)
    // Where editing isn't offered the change actions go; where it is but
    // can't be kept yet, they stay disabled with the reason.
    const editing = useEntityEditing()
    const change = (request: OpRequest) =>
        editing.offered ? () => usePropertyJobsStore.getState().requestOp(request) : undefined
    const selected = useCanvasStore((s) => s.selectedNodeIds.filter((id) => !id.startsWith('logical:')).length)
    // A property made a field of its types, in the semantic layer — by who may edit the layer.
    const canEditLayer = useSemanticLayerAccess().canEdit
    const [promoting, setPromoting] = useState<SearchCatalogProperty | null>(null)

    const properties = useMemo(() => catalog?.properties ?? [], [catalog])
    const tags = useMemo(() => catalog?.tags ?? [], [catalog])
    const entities = catalog?.entities ?? 0

    const knownKeys = useMemo(() => new Set(properties.map((p) => p.key)), [properties])
    // Properties a change on the draft gives entities that none held before (a set, a fill, or the
    // new name of a rename or a copy). The catalog is the draft's, so each joins it with its real
    // counts as the change's first batch lands; until then it is shown here, as what is coming.
    const pendingNewKeys = useMemo(() => {
        const keys = new Set<string>()
        for (const t of jobs) {
            if (t.job?.status === 'failed' || t.job?.status === 'cancelled') continue
            const k = t.op.kind === 'rename' || t.op.kind === 'copy' ? t.op.to : t.op.kind === 'remove' ? undefined : t.op.key
            if (k && !knownKeys.has(k)) keys.add(k)
        }
        return [...keys].sort()
    }, [jobs, knownKeys])
    // The value a new property is set to (for its preview chip).
    const stagedValueByKey = useMemo(() => {
        const m = new Map<string, string>()
        for (const t of jobs) {
            if ((t.op.kind === 'set' || t.op.kind === 'fillEmpty') && t.op.value !== undefined && !m.has(t.op.key)) {
                m.set(t.op.key, String(t.op.value))
            }
        }
        return m
    }, [jobs])

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
                <PropertyJobsPanel jobs={jobs} />
                <EmptyHero onNew={change({})} blocked={editing.blocked} />
            </div>
        )
    }

    const rows = listed.slice(0, shown)

    return (
        <div className="flex flex-col gap-3">
            <PropertyInsightsHeader catalog={catalog} reading={reading} error={error} onRefresh={refresh} />

            <PropertyJobsPanel jobs={jobs} />

            {selected >= 2 && (
                <button
                    type="button"
                    onClick={() => useCanvasStore.getState().openNodesDrawer(useCanvasStore.getState().selectedNodeIds)}
                    className="flex items-center gap-3 rounded-2xl border border-accent-lineage/30 bg-accent-lineage/[0.06] px-3.5 py-2.5 text-left hover:bg-accent-lineage/[0.1] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                >
                    <Layers className="w-4 h-4 text-accent-lineage shrink-0" aria-hidden />
                    <span className="flex-1 min-w-0">
                        <span className="block text-[12.5px] font-semibold text-ink">{selected.toLocaleString()} selected on the canvas</span>
                        <span className="block text-[11px] text-ink-muted">Compare their properties — and change them together</span>
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-accent-lineage shrink-0" aria-hidden />
                </button>
            )}

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
                {editing.offered && (
                    <HoverTip
                        label="Change a property on many entities"
                        detail={editing.blocked ?? 'Set, fill, rename, copy or remove it — on a layer, inside a container, a search’s matches, or the whole view'}
                        className="shrink-0 inline-flex"
                    >
                        <button
                            type="button"
                            onClick={() => usePropertyJobsStore.getState().requestOp({})}
                            disabled={!!editing.blocked}
                            className="inline-flex items-center gap-1.5 px-2.5 h-9 rounded-lg text-[12px] font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors disabled:opacity-50 disabled:shadow-none disabled:hover:bg-accent-lineage"
                        >
                            <Plus className="w-3.5 h-3.5" /> New
                        </button>
                    </HoverTip>
                )}
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
                                onUpdate={change({ kind: 'set', key })}
                                onRemove={change({ kind: 'remove', key })}
                                blocked={editing.blocked}
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
                                onUpdate={change({ kind: 'set', key: property.key })}
                                onDuplicate={change({ kind: 'copy', key: property.key })}
                                onRemove={change({ kind: 'remove', key: property.key })}
                                onCleanUp={change({ kind: 'normalize', key: property.key })}
                                onMerge={editing.offered ? (map) => usePropertyJobsStore.getState().requestOp(
                                    { kind: 'mapValues', key: property.key, ...(map ? { map } : {}) }) : undefined}
                                onConvert={editing.offered ? (toKind) => usePropertyJobsStore.getState().requestOp(
                                    { kind: 'convert', key: property.key, toKind }) : undefined}
                                blocked={editing.blocked}
                                onCreateRule={() => onCreateRuleFromPredicate(
                                    { kind: 'hasProperty', key: property.key, negate: false }, property.key)}
                                onCopy={() => copyKey(property.key)}
                                onPromote={canEditLayer ? () => setPromoting(property) : undefined}
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

            {promoting && <PromoteFieldDialog property={promoting} onClose={() => setPromoting(null)} />}

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

function EmptyHero({ onNew, blocked }: { onNew?: () => void; blocked: string | null }) {
    const cta = onNew && (
        <button
            type="button"
            onClick={onNew}
            disabled={!!blocked}
            className="relative inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-[12.5px] font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors disabled:opacity-50 disabled:shadow-none disabled:hover:bg-accent-lineage"
        >
            <Plus className="w-4 h-4" /> Create your first property
        </button>
    )
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
                    ones are used, and clean up in bulk — on your draft, however many entities.
                </p>
            </div>
            {cta && (blocked ? <HoverTip label={blocked} className="relative inline-flex">{cta}</HoverTip> : cta)}
        </motion.div>
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

/** One value, as its kind and itself: the text "1" and the number 1 are two values. */
const valueKey = (v: { value: unknown; kind: string }) => JSON.stringify([v.kind, v.value])

/** The kind most of a property's entities store it as (a list's elements aside). */
function dominantKind(kinds: Readonly<Record<string, number>>): ValueKind {
    const held = Object.entries(kinds).filter(([k]) => k in KIND_LABEL && k !== 'List').sort((a, b) => b[1] - a[1])
    return (held[0]?.[0] as ValueKind | undefined) ?? 'String'
}

function PropertyRow({
    property, entities, exact, overlay, onUpdate, onDuplicate, onRemove, onCleanUp, onMerge, onConvert, blocked, onCreateRule, onCopy, onSearch, onPromote,
}: {
    property: SearchCatalogProperty
    /** Entities in the view — what coverage is a share of. */
    entities: number
    /** The catalog is complete: its counts are exact, not "so far". */
    exact: boolean
    overlay?: CatalogOverlayEntry
    onUpdate?: () => void
    /** Copy its values to a new property. */
    onDuplicate?: () => void
    onRemove?: () => void
    /** Tidy its values (find & replace, normalize, …). */
    onCleanUp?: () => void
    /** Merge values into one — these, or the near-duplicates it holds. */
    onMerge?: (map?: ValueMapping[]) => void
    /** Store every value as one kind. */
    onConvert?: (toKind: ValueKind) => void
    blocked: string | null
    onCreateRule: () => void
    onCopy: () => void
    onSearch?: SearchHandler
    /** Make it a field of the types that carry it, in the semantic layer. */
    onPromote?: () => void
}) {
    const [expanded, setExpanded] = useState(false)
    const key = property.key
    const { type, mixed } = storedType(property.kinds)
    // Values that differ only in case or in spaces around them: a merge waiting to be made.
    const similar = useMemo(() => similarGroups(property.values), [property.values])
    const dominant = dominantKind(property.kinds)
    // Values picked from the bars to merge into one — by value, not by place: the values reorder
    // while the catalog is read.
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    const togglePicked = (i: number) => setPicked((s) => {
        const next = new Set(s)
        const k = valueKey(property.values[i]!)
        if (!next.delete(k)) next.add(k)
        return next
    })
    const pickedAt = useMemo(
        () => new Set(property.values.flatMap((v, i) => (picked.has(valueKey(v)) ? [i] : []))),
        [property.values, picked],
    )
    const mergePicked = () => {
        // Into the most held of them as they stand now; the dialog offers to keep another.
        const held = new Map(property.values.map((v) => [valueKey(v), v.count]))
        const chosen = [...picked]
            .map((k) => { const [kind, value] = JSON.parse(k) as [ValueKind, unknown]; return { kind, value, count: held.get(k) ?? -1 } })
            .sort((a, b) => b.count - a.count)
        const [into, ...rest] = chosen
        if (!into || !onMerge) return
        onMerge(rest.map((v) => ({ from: v.value, fromKind: v.kind, to: into.value, toKind: into.kind })))
        setPicked(new Set())
    }
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
                        {similar.length > 0 && (
                            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30">
                                <Combine className="w-2.5 h-2.5" aria-hidden /> similar values
                            </span>
                        )}
                        {overlay && (
                            <PendingBadge
                                label={`${pendingRemove ? 'removed' : overlay.kinds.has('rename') ? 'renamed' : overlay.kinds.has('copy') ? 'copied' : 'changed'}${overlay.running ? '…' : ''}`}
                                tone={pendingRemove ? 'rose' : 'amber'}
                            />
                        )}
                        <div className="ml-auto shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                <RowAction icon={<Copy className="w-3 h-3" />} label="Copy the name" onClick={onCopy} />
                                {onUpdate && <RowAction icon={<Pencil className="w-3 h-3" />} label="Change" onClick={onUpdate} blocked={blocked} />}
                                {onDuplicate && <RowAction icon={<CopyPlus className="w-3 h-3" />} label="Duplicate as…" onClick={onDuplicate} blocked={blocked} />}
                                {onCleanUp && <RowAction icon={<WandSparkles className="w-3 h-3" />} label="Clean up…" onClick={onCleanUp} blocked={blocked} />}
                                {onRemove && <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger blocked={blocked} />}
                                {onPromote && <RowAction icon={<ListChecks className="w-3 h-3" />} label="Make it a field…" onClick={onPromote} />}
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
                        {similar.length > 0 && onMerge && !blocked && (
                            <QuickActionCard
                                icon={<Combine className="w-3.5 h-3.5" />}
                                label="Merge similar values…"
                                onClick={() => onMerge()}
                            />
                        )}
                    </div>

                    {similar.length > 0 && (
                        <p className="text-[11px] text-ink-muted leading-snug">
                            {similar.slice(0, 2).map((g, i) => (
                                <span key={g.key}>
                                    {i > 0 && '; '}
                                    {g.members.map((m) => `“${String(m.value)}”`).join(', ')}
                                </span>
                            ))}
                            {similar.length > 2 && ` and ${similar.length - 2} more`} differ only in case or spaces — a search
                            or a rule tells them apart.
                        </p>
                    )}

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
                            {onConvert && !blocked && (
                                <button
                                    type="button"
                                    onClick={() => onConvert(dominant)}
                                    className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/20 transition-colors"
                                >
                                    <ArrowRightLeft className="w-3 h-3" aria-hidden /> Convert all to {KIND_LABEL[dominant] ?? dominant}…
                                </button>
                            )}
                        </div>
                    )}

                    {property.min !== undefined && property.min !== null && (
                        <div className="text-[11px] text-ink-muted">
                            Numbers {property.rangeExact === false ? 'within' : 'from'}{' '}
                            <span className="font-mono text-ink">{String(property.min)}</span>
                            {' '}to <span className="font-mono text-ink">{String(property.max)}</span>
                            {/* A draft took out a value at an end: every value is still in this range. */}
                            {property.rangeExact === false && ' — your draft changed values at its ends'}
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
                                selectable={onMerge && !blocked && values.length > 1 ? { selected: pickedAt, onToggle: togglePicked } : undefined}
                            />
                            {picked.size > 0 && onMerge && (
                                <div className="flex items-center gap-2 rounded-lg border border-accent-lineage/30 bg-accent-lineage/[0.06] px-2.5 py-1.5 text-[11px] text-ink-secondary" aria-live="polite">
                                    <span className="flex-1 min-w-0">
                                        {picked.size === 1 ? 'Pick another value to merge it with' : `${picked.size} values picked — they become one`}
                                    </span>
                                    <button type="button" onClick={() => setPicked(new Set())} className="text-ink-muted hover:text-ink">Clear</button>
                                    <button
                                        type="button"
                                        disabled={picked.size < 2}
                                        onClick={mergePicked}
                                        className="inline-flex items-center gap-1 rounded-md bg-accent-lineage px-2 py-1 font-semibold text-white hover:bg-accent-lineage/90 disabled:opacity-50 transition-colors"
                                    >
                                        <Combine className="w-3 h-3" aria-hidden /> Merge into…
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="text-[11px] text-ink-muted leading-snug">
                            More than {property.distinct.toLocaleString()} distinct values — too many to list,
                            every one still searchable.
                        </p>
                    )}

                    {property.residual > 0 && (
                        <p className="text-[11px] text-ink-muted leading-snug">
                            {property.residual.toLocaleString()} {property.residual === 1 ? 'entity holds' : 'entities hold'} it
                            past the graph's native-property budget, as raw text — search still
                            compares those values exactly, only more slowly.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}


/** A property a change on the draft gives entities, that none carried before. */
function PendingNewRow({
    propertyKey, stagedValue, onUpdate, onRemove, blocked, onCreateRule,
}: {
    propertyKey: string
    stagedValue?: string
    onUpdate?: () => void
    onRemove?: () => void
    blocked: string | null
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
                            {onUpdate && <RowAction icon={<Pencil className="w-3 h-3" />} label="Update" onClick={onUpdate} blocked={blocked} />}
                            {onRemove && <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger blocked={blocked} />}
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

/** A row's icon action. ``blocked`` disables it, and its tooltip says why. */
function RowAction({ icon, label, onClick, danger, blocked }: {
    icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; blocked?: string | null
}) {
    const button = (
        <button
            type="button"
            onClick={onClick}
            disabled={!!blocked}
            title={blocked ? undefined : label}
            aria-label={label}
            className={cn(
                'inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors disabled:opacity-40',
                blocked ? 'text-ink-muted'
                    : danger ? 'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10' : 'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
            )}
        >
            {icon}
        </button>
    )
    return blocked ? <HoverTip label={label} detail={blocked} className="inline-flex">{button}</HoverTip> : button
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
