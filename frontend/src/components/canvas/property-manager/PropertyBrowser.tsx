/**
 * PropertyBrowser — the Properties tab: a premium property-management
 * surface. It opens with an insights overview, lists every property key in
 * use with type badges + lazy usage/value-distribution analytics, and lets
 * the user create / update / remove properties in bulk across a matched set
 * of entities.
 *
 * Lifecycle operations are staged IN-SESSION (``propertyDraftStore``) and
 * surfaced optimistically over the catalogue — there is no backend
 * node-property write yet, so the copy makes clear nothing is persisted.
 */
import { motion } from 'framer-motion'
import {
    ArrowDownWideNarrow, ChevronRight, CircleSlash, Database, Layers, Loader2, Pencil, Plus,
    ScanSearch, Search, Sparkles, Tag, Tags, Trash2, Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePropertyUsage } from '@/hooks/usePropertyUsage'
import { useCatalogOverview, useValueDistribution } from '@/hooks/usePropertyInsights'
import {
    usePropertyCatalogOverlay, usePropertyDraftStore, usePropertyOps,
    type CatalogOverlayEntry, type PropertyOp,
} from '@/store/propertyDraftStore'
import type { Predicate } from '@/types/search'

import { useDiscovery } from '../search/builder/useDiscovery'
import { fieldClass } from '../search/builder/editors/shared'

import { PropertyInsightsHeader } from './PropertyInsightsHeader'
import { PropertyOperationDialog, type PropertyDialogMode } from './PropertyOperationDialog'
import { RankedValueBars, UsageGauge } from './PropertyInsightCharts'
import { EntityTypeChips, SampleValueChips, TypeTile } from './PropertyValueChips'
import { inferType, type ValueType } from './propertyValueTypes'


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
type SortMode = 'name' | 'coverage'


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

    const disc = useDiscovery(viewId)
    const { allKeys, keysByEntityType, tagValues, getValueSamples, isInitialLoading, error } = disc
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<SortMode>('name')
    const [dialog, setDialog] = useState<DialogState>(null)

    const pendingOps = usePropertyOps()
    const overlay = usePropertyCatalogOverlay()
    // View-wide entity total (cached) — feeds each row's coverage gauge.
    const overview = useCatalogOverview(viewId)
    const viewTotal = overview.data?.totalEntities ?? 0

    // Reverse the per-entity-type map so each key lists the entity types
    // that use it (the "usage" the brief asks for).
    const typesByKey = useMemo(() => {
        const out: Record<string, string[]> = {}
        for (const [entityType, keys] of Object.entries(keysByEntityType)) {
            for (const k of keys) (out[k] ??= []).push(entityType)
        }
        for (const k of Object.keys(out)) out[k].sort()
        return out
    }, [keysByEntityType])

    const discoveredSet = useMemo(() => new Set(allKeys), [allKeys])
    const pendingNewKeys = useMemo(
        () => [...overlay.keys()].filter(
            (k) => !discoveredSet.has(k) && (overlay.get(k)!.kinds.has('set') || overlay.get(k)!.kinds.has('fillEmpty')),
        ).sort(),
        [overlay, discoveredSet],
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

    // Catalogue-level guidance from discovery (0-cost).
    const warnings = useMemo(() => {
        const raw = disc.discovery
        const out: string[] = []
        if (!raw) return out
        if (raw.missingContainment) out.push('No containment edges — hierarchy insights limited')
        const blob = raw.blobOnlyLabels ?? []
        if (blob.length > 0) out.push(`${blob.length} type${blob.length === 1 ? '' : 's'} not yet migrated — limited analytics`)
        const truncated = Object.values(raw.labels ?? {}).some((l) => l?.truncatedProperties)
        if (truncated) out.push('Some rare properties may be sampled out')
        return out
    }, [disc.discovery])

    const q = query.trim().toLowerCase()
    const sortKeys = useMemo(() => {
        const base = q ? allKeys.filter((k) => k.toLowerCase().includes(q)) : allKeys
        if (sort === 'coverage') {
            return [...base].sort((a, b) => (typesByKey[b]?.length ?? 0) - (typesByKey[a]?.length ?? 0) || a.localeCompare(b))
        }
        return base
    }, [allKeys, q, sort, typesByKey])
    const filteredNewKeys = useMemo(
        () => (q ? pendingNewKeys.filter((k) => k.toLowerCase().includes(q)) : pendingNewKeys),
        [pendingNewKeys, q],
    )
    const filteredTags = useMemo(
        () => (q ? tagValues.filter((t) => t.toLowerCase().includes(q)) : tagValues),
        [tagValues, q],
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

    if (isInitialLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-ink-muted justify-center">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Discovering properties, values and tags for this view…
            </div>
        )
    }
    if (error) {
        return (
            <div className="px-3 py-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
                Discovery failed — {error.message}
            </div>
        )
    }

    const nothingDiscovered = allKeys.length === 0 && tagValues.length === 0 && pendingNewKeys.length === 0

    if (nothingDiscovered) {
        return (
            <div className="flex flex-col gap-3">
                {pendingOps.length > 0 && <PendingChanges ops={pendingOps} />}
                <EmptyHero onNew={() => setDialog({ mode: 'create' })} />
                {dialogEl}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <PropertyInsightsHeader
                viewId={viewId}
                propertyCount={allKeys.length}
                tagCount={tagValues.length}
                entityTypeCount={Object.keys(keysByEntityType).length}
                warnings={warnings}
            />

            {pendingOps.length > 0 && <PendingChanges ops={pendingOps} />}

            {/* Toolbar: filter + sort + New */}
            <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter properties and tags…"
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
            {(sortKeys.length > 0 || filteredNewKeys.length > 0) && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Database className="w-3 h-3" /> Properties · {sortKeys.length + filteredNewKeys.length}
                    </h4>
                    <div className="flex flex-col gap-1.5">
                        {filteredNewKeys.map((key) => (
                            <PropertyRow
                                key={`new-${key}`}
                                viewId={viewId}
                                propertyKey={key}
                                usedBy={[]}
                                samples={[]}
                                overlay={overlay.get(key)}
                                isPendingNew
                                stagedValue={stagedValueByKey.get(key)}
                                onUpdate={() => setDialog({ mode: 'update', key })}
                                onRemove={() => setDialog({ mode: 'remove', key })}
                                onCreateRule={() => onCreateRuleFromPredicate({ kind: 'hasProperty', key, negate: false }, key)}
                            />
                        ))}
                        {sortKeys.map((key) => (
                            <PropertyRow
                                key={key}
                                viewId={viewId}
                                viewTotal={viewTotal}
                                onSearch={search}
                                propertyKey={key}
                                usedBy={typesByKey[key] ?? []}
                                samples={getValueSamples(key)}
                                overlay={overlay.get(key)}
                                onUpdate={() => setDialog({ mode: 'update', key })}
                                onRemove={() => setDialog({ mode: 'remove', key })}
                                onCreateRule={() => onCreateRuleFromPredicate({ kind: 'hasProperty', key, negate: false }, key)}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* Tags */}
            {filteredTags.length > 0 && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Tag className="w-3 h-3" /> Tags · {filteredTags.length}
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                        {filteredTags.map((tag) => (
                            <button
                                key={tag}
                                type="button"
                                onClick={() => onCreateRuleFromPredicate({ kind: 'tag', op: 'hasAny', values: [tag] }, tag)}
                                title={`Create a display rule tagging entities with "${tag}"`}
                                className="group inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-accent-lineage/12 text-accent-lineage hover:bg-accent-lineage/22 transition-colors"
                            >
                                {tag}
                                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                        ))}
                    </div>
                </section>
            )}

            {sortKeys.length === 0 && filteredNewKeys.length === 0 && filteredTags.length === 0 && (
                <div className="px-3 py-5 text-center text-[11px] text-ink-muted">
                    Nothing matches <span className="font-mono text-ink">{query}</span>.
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
        <div className="shrink-0 inline-flex rounded-lg p-0.5 bg-canvas-base/40 border border-glass-border/50">
            {(['name', 'coverage'] as SortMode[]).map((s) => (
                <button
                    key={s}
                    type="button"
                    onClick={() => onChange(s)}
                    title={s === 'name' ? 'Sort A–Z' : 'Sort by how many entity types use it'}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 h-8 rounded-md text-[11px] font-medium transition-colors',
                        sort === s ? 'bg-accent-lineage/20 text-accent-lineage' : 'text-ink-muted hover:text-ink',
                    )}
                >
                    {s === 'name' ? 'A–Z' : <><ArrowDownWideNarrow className="w-3 h-3" /> Usage</>}
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
// Property row (expandable: usage + value distribution + lifecycle actions)
// ---------------------------------------------------------------------------

function PropertyRow({
    viewId, viewTotal = 0, propertyKey, usedBy, samples, overlay, isPendingNew, stagedValue, onUpdate, onRemove, onCreateRule, onSearch,
}: {
    viewId: string
    viewTotal?: number
    propertyKey: string
    usedBy: string[]
    samples: unknown[]
    overlay?: CatalogOverlayEntry
    isPendingNew?: boolean
    stagedValue?: string
    onUpdate: () => void
    onRemove: () => void
    onCreateRule: () => void
    onSearch?: SearchHandler
}) {
    const [expanded, setExpanded] = useState(false)
    const usage = usePropertyUsage(viewId, propertyKey, expanded && !isPendingNew)
    const dist = useValueDistribution(viewId, propertyKey, expanded && !isPendingNew)

    const valueType = useMemo(() => inferType(samples), [samples])
    // Build + run a query in Advanced Search for a clicked value / action.
    const searchValue = onSearch
        ? (raw: string) => onSearch(
            { kind: 'property', key: propertyKey, op: 'eq', value: coerceValue(raw, valueType) } as Predicate,
            `${propertyKey} = ${raw}`,
        )
        : undefined
    const sampleText = useMemo(
        () => samples.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).filter((s) => s.length > 0),
        [samples],
    )
    const pendingRemove = overlay?.kinds.has('remove')
    const accent: 'emerald' | 'rose' | undefined = isPendingNew ? 'emerald' : pendingRemove ? 'rose' : undefined

    const toggle = () => { if (!isPendingNew) setExpanded((v) => !v) }

    return (
        <div className={cn(
            'group relative rounded-2xl border bg-canvas-elevated/40 backdrop-blur-sm transition-all duration-200',
            pendingRemove ? 'border-rose-500/40 shadow-sm'
                : isPendingNew ? 'border-emerald-500/40 shadow-sm'
                    : 'border-glass-border/50 shadow-sm hover:shadow-md hover:-translate-y-px hover:border-glass-border',
        )}>
            <div
                role={isPendingNew ? undefined : 'button'}
                tabIndex={isPendingNew ? undefined : 0}
                onClick={toggle}
                onKeyDown={(e) => { if (!isPendingNew && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}
                className={cn('flex items-start gap-3 px-3.5 py-3', !isPendingNew && 'cursor-pointer')}
            >
                <TypeTile type={valueType} accent={accent} />
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    {/* Title */}
                    <div className="flex items-center gap-2">
                        <span className={cn('font-mono text-[12.5px] truncate', pendingRemove ? 'text-rose-300 line-through' : 'text-ink')} title={propertyKey}>
                            {propertyKey}
                        </span>
                        {isPendingNew && <PendingBadge label="new" tone="emerald" />}
                        {overlay && !isPendingNew && (
                            <PendingBadge
                                label={pendingRemove ? 'remove' : overlay.kinds.has('rename') ? 'rename' : 'edit'}
                                tone={pendingRemove ? 'rose' : 'amber'}
                            />
                        )}
                        <div className="ml-auto shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <RowAction icon={<Pencil className="w-3 h-3" />} label="Update" onClick={onUpdate} />
                                <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger />
                                <RowAction icon={<Plus className="w-3 h-3" />} label="Create rule" onClick={onCreateRule} />
                            </div>
                            {!isPendingNew && (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg text-ink-muted/60 group-hover:bg-glass/40 transition-colors">
                                    <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-90')} />
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Used by */}
                    {usedBy.length > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-ink-muted/80 min-w-0">
                            <span className="shrink-0">Used by</span>
                            <EntityTypeChips types={usedBy} />
                        </div>
                    )}

                    {/* Sample values */}
                    {sampleText.length > 0 && <SampleValueChips values={sampleText} onValueClick={searchValue} />}
                    {isPendingNew && stagedValue !== undefined && stagedValue !== '' && (
                        <SampleValueChips values={[stagedValue]} />
                    )}
                </div>
            </div>

            {expanded && !isPendingNew && (
                <div className="px-4 pb-3.5 pl-[3.75rem] border-t border-glass-border/40 pt-3 flex flex-col gap-4">
                    {/* Quick actions — construct + run a query in Advanced Search,
                        or tag matches as a display rule. */}
                    <div className="flex flex-wrap gap-2">
                        {onSearch && (
                            <>
                                <QuickActionCard
                                    icon={<ScanSearch className="w-3.5 h-3.5" />}
                                    label="Find all using this"
                                    onClick={() => onSearch({ kind: 'hasProperty', key: propertyKey, negate: false } as Predicate, `entities using ${propertyKey}`)}
                                />
                                <QuickActionCard
                                    icon={<CircleSlash className="w-3.5 h-3.5" />}
                                    label="Find missing this"
                                    onClick={() => onSearch({ kind: 'hasProperty', key: propertyKey, negate: true } as Predicate, `entities missing ${propertyKey}`)}
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

                    {/* Usage gauge */}
                    {usage.loading ? (
                        <Skel label="Counting usage…" />
                    ) : usage.error ? (
                        <span className="text-[11px] text-rose-400">Couldn't load usage — {usage.error}</span>
                    ) : usage.data ? (
                        <UsageGauge
                            total={usage.data.total}
                            viewTotal={viewTotal}
                            byEntityType={usage.data.byEntityType}
                            onTypeClick={onSearch ? (type) => onSearch(
                                { kind: 'group', op: 'and', children: [
                                    { kind: 'hasProperty', key: propertyKey, negate: false },
                                    { kind: 'entityType', op: 'in', values: [type] },
                                ] } as Predicate,
                                `${propertyKey} on ${type}`,
                            ) : undefined}
                        />
                    ) : null}

                    {/* Top values */}
                    {dist.loading ? (
                        <Skel label="Analysing values…" />
                    ) : dist.data && dist.data.values.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                                Top values{dist.data.truncated ? ' · sampled' : ''}
                            </div>
                            <RankedValueBars
                                items={dist.data.values.map((v) => ({ label: v.value, count: v.count }))}
                                total={usage.data?.total ?? dist.data.values.reduce((s, v) => s + v.count, 0)}
                                onItemClick={searchValue ? (it) => searchValue(it.label) : undefined}
                            />
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    )
}


function Skel({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
            <Loader2 className="w-3 h-3 animate-spin" /> {label}
        </span>
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
                danger ? 'text-ink-muted/70 hover:text-rose-400 hover:bg-rose-500/10' : 'text-ink-muted/70 hover:text-accent-lineage hover:bg-accent-lineage/10',
            )}
        >
            {icon}
        </button>
    )
}


/** Coerce a string sample value to its inferred type for `property = value`. */
function coerceValue(raw: string, type: ValueType): string | number | boolean {
    if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : raw }
    if (type === 'boolean') return raw === 'true'
    return raw
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
                    : 'border-glass-border/60 bg-canvas-base/30 text-ink-secondary hover:text-ink hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.06]',
            )}
        >
            {icon}
            {label}
        </button>
    )
}
