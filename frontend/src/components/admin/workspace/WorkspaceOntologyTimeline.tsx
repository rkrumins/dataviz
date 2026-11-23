/**
 * What changed in a workspace's data model: one card per semantic layer its sources use — the
 * sources that share it, what it holds, and each change to it, newest first, who made it and when.
 * A layer two sources share is one card, so its history is never read twice.
 */
import { useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
    ArrowUpRight, BadgeCheck, Box, ChevronDown, Clock, CopyPlus, Database, History, Import, Layers, Minus, PenLine, Plus,
    RotateCcw, Share2, Sparkles, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService, type OntologyAuditEntry } from '@/services/ontologyDefinitionService'
import { ONTOLOGY_KEYS } from '@/features/ontology/hooks/useOntologies'
import { mapWithConcurrency } from '@/lib/concurrency'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { PersonChip } from '@/components/ui/PersonChip'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'

interface WorkspaceOntologyTimelineProps {
    dataSources: DataSourceResponse[]
    ontologyMap: Record<string, OntologyDefinitionResponse>
}

type Glyph = ComponentType<{ className?: string }>
type Filter = 'all' | 'published'

/** Each kind of change, by what it is called, its icon and its tint. */
const ACTIONS: Record<string, { label: string; icon: Glyph; tint: string }> = {
    published: { label: 'Published', icon: BadgeCheck, tint: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400' },
    created: { label: 'Created', icon: Sparkles, tint: 'bg-sky-500/12 text-sky-600 ring-sky-500/20 dark:text-sky-400' },
    updated: { label: 'Edited', icon: PenLine, tint: 'bg-indigo-500/12 text-indigo-600 ring-indigo-500/20 dark:text-indigo-400' },
    deleted: { label: 'Deleted', icon: Trash2, tint: 'bg-rose-500/12 text-rose-600 ring-rose-500/20 dark:text-rose-400' },
    restored: { label: 'Restored', icon: RotateCcw, tint: 'bg-amber-500/12 text-amber-600 ring-amber-500/20 dark:text-amber-400' },
    cloned: { label: 'New draft', icon: CopyPlus, tint: 'bg-violet-500/12 text-violet-600 ring-violet-500/20 dark:text-violet-400' },
    imported: { label: 'Imported into', icon: Import, tint: 'bg-cyan-500/12 text-cyan-600 ring-cyan-500/20 dark:text-cyan-400' },
}
const OTHER = { icon: History, tint: 'bg-slate-500/12 text-slate-600 ring-slate-500/20 dark:text-slate-300' }

/** The newest changes a card shows before "Show earlier". */
const LATEST = 5

const FILTERS = [
    { value: 'all', label: 'All changes' },
    { value: 'published', label: 'Published only' },
] as const

export function WorkspaceOntologyTimeline({ dataSources, ontologyMap }: WorkspaceOntologyTimelineProps) {
    const [filter, setFilter] = useState<Filter>('all')

    // One layer per semantic layer, with every source that uses it, in the sources' order.
    const layers = useMemo(() => {
        const byId = new Map<string, { ontology: OntologyDefinitionResponse; sources: DataSourceResponse[] }>()
        for (const ds of dataSources) {
            const ontology = ds.ontologyId ? ontologyMap[ds.ontologyId] : undefined
            if (!ontology) continue
            const layer = byId.get(ontology.id)
            if (layer) layer.sources.push(ds)
            else byId.set(ontology.id, { ontology, sources: [ds] })
        }
        return [...byId.values()]
    }, [dataSources, ontologyMap])
    const ids = layers.map(l => l.ontology.id)

    const audit = useQuery({
        queryKey: [...ONTOLOGY_KEYS.all, 'audit-of', ids],
        enabled: ids.length > 0,
        staleTime: 30_000,
        // WS0.4: cap the per-layer fan-out so it can't storm the browser connection budget when
        // a workspace has many layers. A layer whose history could not be read is `null`.
        queryFn: async () => {
            const results = await mapWithConcurrency(ids, 4, id => ontologyDefinitionService.auditLog(id))
            return Object.fromEntries(ids.map((id, i) => {
                const r = results[i]
                return [id, r.status === 'fulfilled' ? r.value : null]
            })) as Record<string, OntologyAuditEntry[] | null>
        },
    })

    return (
        <section aria-labelledby="ws-model-history" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <h3 id="ws-model-history" className="text-lg font-bold text-ink">What changed in your data model</h3>
                    <p className="mt-0.5 text-xs text-ink-muted">Each semantic layer your sources use, and who changed it, when — newest first.</p>
                </div>
                {layers.length > 0 && (
                    <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Which changes to show" />
                )}
            </div>

            {layers.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-glass-border/70 pb-10">
                    <EmptyState
                        icon={Layers}
                        className="pb-0"
                        title="No semantic layer yet"
                        description="A semantic layer names the kinds of things your data holds and how they connect. Choose one for a data source in its details, or make one in Semantic Layers — every change to it will show here."
                    />
                    <div className="mt-4 flex justify-center">
                        <Link
                            to="/schema"
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-700"
                        >
                            Open Semantic Layers <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </Link>
                    </div>
                </div>
            ) : audit.isLoading ? (
                <div aria-busy="true" aria-label="Loading what changed" className="space-y-4">
                    {layers.slice(0, 3).map(l => <LayerCardSkeleton key={l.ontology.id} />)}
                </div>
            ) : (
                <div className="space-y-4">
                    {layers.map(({ ontology, sources }) => (
                        <LayerCard
                            key={ontology.id}
                            ontology={ontology}
                            sources={sources}
                            entries={audit.data?.[ontology.id] ?? null}
                            filter={filter}
                        />
                    ))}
                </div>
            )}
        </section>
    )
}

function LayerCard({ ontology, sources, entries, filter }: {
    ontology: OntologyDefinitionResponse
    sources: DataSourceResponse[]
    /** Newest first; `null` when the history could not be read. */
    entries: OntologyAuditEntry[] | null
    filter: Filter
}) {
    const [expanded, setExpanded] = useState(false)
    const all = entries ?? []
    const shown = filter === 'published' ? all.filter(e => e.action === 'published') : all
    const visible = expanded ? shown : shown.slice(0, LATEST)
    const earlier = shown.length - visible.length
    // The versions this history records; a layer with none recorded is at least the one it is.
    const versions = new Set(all.map(e => e.version).filter(v => v != null)).size || ontology.version
    const headingId = `layer-${ontology.id}`

    return (
        <article aria-labelledby={headingId} className="rounded-2xl border border-glass-border bg-canvas-elevated shadow-sm ring-1 ring-black/[0.04] dark:shadow-none dark:ring-0">
            <div className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                    <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
                        <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-600 ring-1 ring-inset ring-violet-500/20 dark:text-violet-400">
                            <Layers className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <h4 id={headingId} className="min-w-0 max-w-full truncate text-[15px] font-bold text-ink" title={ontology.name}>
                                    {ontology.name}
                                </h4>
                                <span className="text-xs font-semibold tabular-nums text-ink-muted">v{ontology.version}</span>
                                <StatusPill published={ontology.isPublished} />
                            </div>
                            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                                <span className="text-[11px] text-ink-muted">Used by</span>
                                {sources.map(ds => (
                                    <span key={ds.id} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-ink-secondary ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06]">
                                        <Database className="h-3 w-3 shrink-0" aria-hidden />
                                        <span className="truncate">{ds.label || 'Unnamed'}</span>
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                    <Link
                        to={`/schema/${ontology.id}`}
                        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-glass-border bg-black/5 px-3 py-2 text-[11px] font-semibold text-ink transition-colors hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                    >
                        Open in Semantic Layers <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    </Link>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-glass-border/60 bg-glass-border/60 sm:grid-cols-4">
                    <Stat icon={Box} label="Kinds of thing" value={Object.keys(ontology.entityTypeDefinitions ?? {}).length} />
                    <Stat icon={Share2} label="Kinds of connection" value={Object.keys(ontology.relationshipTypeDefinitions ?? {}).length} />
                    <Stat icon={History} label="Versions" value={versions} />
                    <Stat icon={Clock} label="Last change" value={<DateTime at={all[0]?.createdAt ?? ontology.updatedAt} />} />
                </dl>
            </div>

            <div className="border-t border-glass-border/60 px-2 py-2 sm:px-3">
                {entries === null ? (
                    <p className="px-3 py-3 text-xs text-ink-muted">This layer’s history couldn’t be loaded just now.</p>
                ) : shown.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-ink-muted">
                        {all.length === 0 ? 'No changes recorded yet.' : 'No published changes yet.'}
                    </p>
                ) : (
                    <>
                        <ol aria-label={`Changes to ${ontology.name}`}>
                            {visible.map((entry, i) => (
                                <ChangeRow key={entry.id} entry={entry} last={i === visible.length - 1} />
                            ))}
                        </ol>
                        {earlier > 0 && (
                            <button
                                type="button"
                                onClick={() => setExpanded(true)}
                                className="mb-1 ml-[52px] inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-secondary transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
                            >
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                Show {earlier} earlier {earlier === 1 ? 'change' : 'changes'}
                            </button>
                        )}
                    </>
                )}
            </div>
        </article>
    )
}

function StatusPill({ published }: { published: boolean }) {
    return (
        <span className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            published
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        )}>
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', published ? 'bg-emerald-500' : 'bg-amber-500')} />
            {published ? 'Published' : 'Draft'}
        </span>
    )
}

function Stat({ icon: Icon, label, value }: { icon: Glyph; label: string; value: ReactNode }) {
    return (
        <div className="min-w-0 bg-canvas-elevated px-3 py-2.5">
            <dt className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-muted">
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
            </dt>
            <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-ink">{value}</dd>
        </div>
    )
}

function ChangeRow({ entry, last }: { entry: OntologyAuditEntry; last: boolean }) {
    const action = ACTIONS[entry.action]
    const { icon: Icon, tint } = action ?? OTHER
    const label = action?.label ?? entry.action.charAt(0).toUpperCase() + entry.action.slice(1)
    const title = entry.version != null ? `${label} v${entry.version}` : label
    const changes = entry.changes
    const groups = changes ? [
        { label: 'Things', added: changes.addedEntityTypes ?? [], removed: changes.removedEntityTypes ?? [] },
        { label: 'Connections', added: changes.addedRelationshipTypes ?? [], removed: changes.removedRelationshipTypes ?? [] },
    ].filter(g => g.added.length + g.removed.length > 0) : []
    // The chips say what changed in plain words; a summary only repeating them (or the title) is left out.
    const summary = entry.summary && entry.summary !== title && groups.length === 0 ? entry.summary : null

    return (
        <li className="relative flex gap-3 px-3 py-3">
            {/* The spine, from this change's mark to the next one's. */}
            {!last && <span aria-hidden className="absolute -bottom-1 left-[27.5px] top-[48px] w-px bg-black/10 dark:bg-white/10" />}
            <span aria-hidden className={cn('relative grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset', tint)}>
                <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-sm font-semibold leading-5 text-ink">{title}</span>
                        {entry.actor
                            ? <PersonChip id={entry.actor} size="xs" />
                            : <span className="text-[11px] text-ink-muted">System</span>}
                    </div>
                    {/* One line as tall as the title's, so the two sit level. */}
                    <span className="shrink-0 text-[11px] leading-5 text-ink-muted"><DateTime at={entry.createdAt} /></span>
                </div>
                {summary && <p className="mt-1 break-words text-xs text-ink-secondary">{summary}</p>}
                {groups.length > 0 && (
                    <dl className="mt-2 w-fit max-w-full space-y-1.5 rounded-xl bg-black/[0.02] p-2.5 ring-1 ring-inset ring-black/[0.04] dark:bg-white/[0.03] dark:ring-white/[0.05]">
                        {groups.map(g => (
                            <div key={g.label} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                                <dt className="shrink-0 text-[11px] font-semibold leading-5 text-ink-secondary sm:w-24">{g.label}</dt>
                                <dd className="flex min-w-0 flex-wrap gap-1">
                                    {g.added.map(t => <TypeChip key={`+${t}`} name={t} added />)}
                                    {g.removed.map(t => <TypeChip key={`-${t}`} name={t} />)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                )}
            </div>
        </li>
    )
}

function TypeChip({ name, added = false }: { name: string; added?: boolean }) {
    const Sign = added ? Plus : Minus
    return (
        <span className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium leading-5',
            added
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        )}>
            <Sign className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">{added ? 'Added' : 'Removed'} </span>
            <span className="truncate">{name}</span>
        </span>
    )
}

function LayerCardSkeleton() {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 shadow-sm ring-1 ring-black/[0.04] dark:shadow-none dark:ring-0 sm:p-5">
            <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                    <Skeleton className="h-4 w-48 max-w-full" />
                    <Skeleton className="h-3 w-64 max-w-full" />
                </div>
            </div>
            <Skeleton className="mt-4 h-14 rounded-xl" />
            <div className="mt-5 space-y-5">
                {[0, 1, 2].map(i => (
                    <div key={i} className="flex gap-3">
                        <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                        <div className="min-w-0 flex-1 space-y-2 pt-1">
                            <Skeleton className="h-3.5 w-40 max-w-full" />
                            <Skeleton className="h-3 w-3/4" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
