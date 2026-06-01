/**
 * PropertyBrowser — the Properties tab: a property-management surface, not
 * just a catalogue. It lists every property key in use (from discovery)
 * with live usage insights, and lets the user create / update / remove
 * properties in bulk across a matched set of entities.
 *
 * Lifecycle operations are staged IN-SESSION (``propertyDraftStore``) and
 * surfaced optimistically over the catalogue — there is no backend
 * node-property write yet, so a banner makes clear nothing is persisted.
 */
import {
    ChevronRight, Database, Layers, Loader2, Pencil, Plus, Search, Tag, Trash2, Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { usePropertyUsage } from '@/hooks/usePropertyUsage'
import {
    usePropertyCatalogOverlay, usePropertyDraftStore, usePropertyOps,
    type CatalogOverlayEntry, type PropertyOp,
} from '@/store/propertyDraftStore'
import type { Predicate } from '@/types/search'

import { useDiscovery } from '../search/builder/useDiscovery'
import { fieldClass } from '../search/builder/editors/shared'

import { PropertyOperationDialog, type PropertyDialogMode } from './PropertyOperationDialog'


export interface PropertyBrowserProps {
    viewId: string
    knownEntityTypes: string[]
    knownLayers: string[]
    /** Seed a new display rule from a discovered property / tag. */
    onCreateRuleFromPredicate: (predicate: Predicate, suggestedName: string) => void
}

type DialogState = { mode: PropertyDialogMode; key?: string } | null


export function PropertyBrowser({
    viewId, knownEntityTypes, knownLayers, onCreateRuleFromPredicate,
}: PropertyBrowserProps) {
    const {
        allKeys, keysByEntityType, tagValues, getValueSamples, isInitialLoading, error,
    } = useDiscovery(viewId)
    const [query, setQuery] = useState('')
    const [dialog, setDialog] = useState<DialogState>(null)

    const pendingOps = usePropertyOps()
    const overlay = usePropertyCatalogOverlay()

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

    // Staged-new keys: in the overlay but not (yet) discovered.
    const discoveredSet = useMemo(() => new Set(allKeys), [allKeys])
    const pendingNewKeys = useMemo(
        () => [...overlay.keys()].filter(
            (k) => !discoveredSet.has(k) && (overlay.get(k)!.kinds.has('set') || overlay.get(k)!.kinds.has('fillEmpty')),
        ).sort(),
        [overlay, discoveredSet],
    )

    const q = query.trim().toLowerCase()
    const filteredKeys = useMemo(
        () => (q ? allKeys.filter((k) => k.toLowerCase().includes(q)) : allKeys),
        [allKeys, q],
    )
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

    return (
        <div className="flex flex-col gap-3">
            {/* Pending changes banner */}
            {pendingOps.length > 0 && <PendingChanges ops={pendingOps} />}

            {/* Toolbar: filter + New property */}
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
                <button
                    type="button"
                    onClick={() => setDialog({ mode: 'create' })}
                    title="Define a new property and apply it to matched entities"
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-9 rounded-lg text-[12px] font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" /> New
                </button>
            </div>

            {nothingDiscovered && (
                <div className="px-3 py-6 text-center text-[11px] text-ink-muted">
                    No queryable properties or tags were discovered for this view.
                </div>
            )}

            {/* Properties */}
            {(filteredKeys.length > 0 || filteredNewKeys.length > 0) && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Database className="w-3 h-3" /> Properties · {filteredKeys.length + filteredNewKeys.length}
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
                                onUpdate={() => setDialog({ mode: 'update', key })}
                                onRemove={() => setDialog({ mode: 'remove', key })}
                                onCreateRule={() => onCreateRuleFromPredicate({ kind: 'hasProperty', key, negate: false }, key)}
                            />
                        ))}
                        {filteredKeys.map((key) => (
                            <PropertyRow
                                key={key}
                                viewId={viewId}
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

            {!nothingDiscovered && filteredKeys.length === 0 && filteredNewKeys.length === 0 && filteredTags.length === 0 && (
                <div className="px-3 py-5 text-center text-[11px] text-ink-muted">
                    Nothing matches <span className="font-mono text-ink">{query}</span>.
                </div>
            )}

            {dialogEl}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Pending changes banner
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
    return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
                <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="flex-1 min-w-0 text-[11.5px] text-amber-100/90 leading-tight">
                    <span className="font-semibold">{ops.length} staged change{ops.length === 1 ? '' : 's'}</span>
                    {' '}— in-session only, not saved to the graph
                </span>
                <ChevronRight className={cn('w-3.5 h-3.5 text-amber-300/80 shrink-0 transition-transform', open && 'rotate-90')} />
            </button>
            {open && (
                <div className="px-2 pb-2 flex flex-col gap-1 border-t border-amber-500/20 pt-1.5">
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
                    <button
                        type="button"
                        onClick={clearOps}
                        className="self-end mt-0.5 text-[10.5px] text-amber-300/80 hover:text-amber-100 transition-colors"
                    >
                        Discard all
                    </button>
                </div>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Property row (expandable, with usage insights + lifecycle actions)
// ---------------------------------------------------------------------------

function PropertyRow({
    viewId, propertyKey, usedBy, samples, overlay, isPendingNew, onUpdate, onRemove, onCreateRule,
}: {
    viewId: string
    propertyKey: string
    usedBy: string[]
    samples: unknown[]
    overlay?: CatalogOverlayEntry
    isPendingNew?: boolean
    onUpdate: () => void
    onRemove: () => void
    onCreateRule: () => void
}) {
    const [expanded, setExpanded] = useState(false)
    const usage = usePropertyUsage(viewId, propertyKey, expanded && !isPendingNew)

    const sampleText = useMemo(
        () => samples.slice(0, 4).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
        [samples],
    )

    const pendingRemove = overlay?.kinds.has('remove')

    return (
        <div className={cn(
            'group rounded-lg border bg-canvas-base/20 transition-colors',
            pendingRemove ? 'border-rose-500/40' : 'border-glass-border/60 hover:border-glass-border',
        )}>
            <div className="px-3 py-2">
                <div className="flex items-center gap-2">
                    {!isPendingNew && (
                        <button
                            type="button"
                            onClick={() => setExpanded((v) => !v)}
                            title="Show usage"
                            className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-ink-muted/70 hover:text-ink"
                        >
                            <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-90')} />
                        </button>
                    )}
                    <span className={cn('font-mono text-[12px] truncate', pendingRemove ? 'text-rose-300 line-through' : 'text-ink')} title={propertyKey}>
                        {propertyKey}
                    </span>
                    {isPendingNew && <PendingBadge label="new" tone="emerald" />}
                    {overlay && !isPendingNew && (
                        <PendingBadge
                            label={pendingRemove ? 'remove' : overlay.kinds.has('rename') ? 'rename' : 'edit'}
                            tone={pendingRemove ? 'rose' : 'amber'}
                        />
                    )}
                    {/* Actions */}
                    <div className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <RowAction icon={<Pencil className="w-3 h-3" />} label="Update" onClick={onUpdate} />
                        <RowAction icon={<Trash2 className="w-3 h-3" />} label="Remove" onClick={onRemove} danger />
                        <RowAction icon={<Plus className="w-3 h-3" />} label="Rule" onClick={onCreateRule} />
                    </div>
                </div>

                {usedBy.length > 0 && (
                    <div className="mt-1 pl-6 text-[10px] text-ink-muted/80 truncate">
                        Used by: {usedBy.join(', ')}
                    </div>
                )}
                {sampleText.length > 0 && (
                    <div className="mt-1 pl-6 flex flex-wrap gap-1">
                        {sampleText.map((v, i) => (
                            <span key={i} className="px-1.5 py-0.5 rounded bg-glass/40 text-[10px] text-ink-muted font-mono truncate max-w-[140px]" title={v}>
                                {v}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* Usage insights (lazy) */}
            {expanded && !isPendingNew && (
                <div className="px-3 pb-2.5 pl-9 border-t border-glass-border/40 pt-2">
                    {usage.loading ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <Loader2 className="w-3 h-3 animate-spin" /> Counting usage…
                        </span>
                    ) : usage.error ? (
                        <span className="text-[11px] text-rose-400">Couldn't load usage — {usage.error}</span>
                    ) : usage.data ? (
                        <UsageBreakdown total={usage.data.total} byEntityType={usage.data.byEntityType} />
                    ) : null}
                </div>
            )}
        </div>
    )
}


function UsageBreakdown({ total, byEntityType }: { total: number; byEntityType: { type: string; count: number }[] }) {
    if (total === 0) {
        return <span className="text-[11px] text-ink-muted/70">Not used by any entity in this view.</span>
    }
    const max = byEntityType[0]?.count ?? 1
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-ink">
                <span className="font-semibold tabular-nums">{total}</span> {total === 1 ? 'entity uses' : 'entities use'} this property
            </div>
            <div className="flex flex-col gap-1">
                {byEntityType.slice(0, 8).map((b) => (
                    <div key={b.type} className="flex items-center gap-2 text-[10.5px]">
                        <span className="w-24 shrink-0 truncate text-ink-muted" title={b.type}>{b.type}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-glass/30 overflow-hidden">
                            <div className="h-full rounded-full bg-accent-lineage/60" style={{ width: `${Math.max(4, (b.count / max) * 100)}%` }} />
                        </div>
                        <span className="w-8 shrink-0 text-right tabular-nums text-ink-muted">{b.count}</span>
                    </div>
                ))}
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
        <span className={cn('shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border', tones[tone])}>
            {label}
        </span>
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
