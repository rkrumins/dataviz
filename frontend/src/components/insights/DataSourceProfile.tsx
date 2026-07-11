/**
 * DataSourceProfile — the reusable core of a data source's picture.
 *
 * Extracted from DataSourceOverviewPage so the same hero/metrics/composition/
 * used-by/explore sections can be embedded wherever a data source's identity
 * needs to be shown (the standalone page, and — with `context` — a
 * workspace-scoped enhanced view added in a later task).
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import {
    Database, Layers, GitBranch, Compass,
    Boxes, Spline, Tag, Waypoints, Building2, Eye, Clock, ExternalLink,
    ShieldCheck, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDataSourceProfile } from '@/hooks/useDataSourceProfile'
import { useProviderHealth, PROVIDER_HEALTH_META } from '@/store/providerHealthModel'
import { StatusChip } from '@/components/insights/StatusChip'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { aggregationService } from '@/services/aggregationService'
import { VocabAlignmentWarning } from '@/components/admin/workspace/VocabAlignmentWarning'

export interface DataSourceProfileContext {
    wsId: string
    dataSourceId: string
    ontologyId?: string | null
    ontologyName?: string | null
}

// ── helpers ──────────────────────────────────────────────────────────────

function compactNum(n: number | null | undefined): string {
    if (n == null) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
    return String(n)
}

function timeAgo(iso: string | null | undefined): string {
    if (!iso) return '—'
    const diff = (Date.now() - new Date(iso).getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

/** edges-per-node → a plain-language connectivity read. */
function connectivity(nodeCount: number, edgeCount: number): { label: string; pct: number } {
    if (!nodeCount) return { label: 'No data', pct: 0 }
    const ratio = edgeCount / nodeCount
    const pct = Math.max(4, Math.min(100, Math.round((ratio / 4) * 100)))
    const label = ratio < 0.5 ? 'Very sparse' : ratio < 1 ? 'Sparse' : ratio < 2 ? 'Balanced' : ratio < 3.5 ? 'Dense' : 'Very dense'
    return { label, pct }
}

const PROVIDER_TINT: Record<string, string> = {
    falkordb: 'from-amber-500/15 to-orange-500/5 text-amber-500',
    neo4j: 'from-blue-500/15 to-indigo-500/5 text-blue-500',
    datahub: 'from-emerald-500/15 to-teal-500/5 text-emerald-500',
    spanner: 'from-sky-500/15 to-cyan-500/5 text-sky-500',
}

// ── section primitives ────────────────────────────────────────────────────

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn('rounded-2xl border border-glass-border bg-canvas-elevated', className)}>
            {children}
        </div>
    )
}

function CardHeader({ icon: Icon, title, action }: {
    icon: React.ComponentType<{ className?: string }>; title: string; action?: React.ReactNode
}) {
    return (
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <div className="flex items-center gap-2">
                <Icon className="w-4 h-4 text-ink-muted" />
                <h3 className="text-sm font-bold text-ink">{title}</h3>
            </div>
            {action}
        </div>
    )
}

function StatTile({ icon: Icon, label, value, tint, loading }: {
    icon: React.ComponentType<{ className?: string }>
    label: string; value: string; tint: string; loading?: boolean
}) {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 flex items-center gap-3.5">
            <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', tint)}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
                <p className="text-2xl font-black text-ink leading-none tabular-nums">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin text-ink-muted" /> : value}
                </p>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mt-1.5">{label}</p>
            </div>
        </div>
    )
}

/** Horizontal breakdown bars for entity/edge type counts. */
function TypeBreakdown({ counts, accent }: { counts: Record<string, number>; accent: string }) {
    const rows = useMemo(() => {
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
        const max = entries[0]?.[1] ?? 1
        return { entries: entries.slice(0, 8), max, total: entries.length }
    }, [counts])

    if (rows.entries.length === 0) {
        return <p className="px-5 pb-5 text-xs text-ink-muted">No types profiled yet.</p>
    }
    return (
        <div className="px-5 pb-5 space-y-2.5">
            {rows.entries.map(([name, count]) => (
                <div key={name} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-xs font-medium text-ink-secondary" title={name}>{name}</span>
                    <div className="flex-1 h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                        <div className={cn('h-full rounded-full', accent)} style={{ width: `${Math.max(3, (count / rows.max) * 100)}%` }} />
                    </div>
                    <span className="w-14 shrink-0 text-right text-xs font-bold text-ink tabular-nums">{compactNum(count)}</span>
                </div>
            ))}
            {rows.total > rows.entries.length && (
                <p className="pt-1 text-[11px] text-ink-muted">+{rows.total - rows.entries.length} more types</p>
            )}
        </div>
    )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <dt className="text-ink-muted shrink-0">{label}</dt>
            <dd className={cn('text-ink text-right break-words', mono && 'font-mono text-ink-secondary')}>{value}</dd>
        </div>
    )
}

function UsedByList({ icon: Icon, label, items, href, empty }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    items: Array<{ id: string; name: string }>
    href: (id: string) => string
    empty: string
}) {
    return (
        <div>
            <div className="flex items-center gap-1.5 mb-2">
                <Icon className="w-3.5 h-3.5 text-ink-muted" />
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">{label}</span>
                <span className="text-[11px] font-bold text-ink-muted tabular-nums">· {items.length}</span>
            </div>
            {items.length === 0 ? (
                <p className="text-xs text-ink-muted/80">{empty}</p>
            ) : (
                <div className="space-y-1">
                    {items.map((it) => (
                        <Link key={it.id} to={href(it.id)}
                            className="flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-sm text-ink-secondary hover:text-ink transition-colors group">
                            <span className="truncate">{it.name}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </Link>
                    ))}
                </div>
            )}
        </div>
    )
}

/** Read-only aggregation readiness for the data source's workspace binding. */
function AggregationStatusCard({ dataSourceId }: { dataSourceId: string; wsId: string }) {
    const { data } = useQuery({
        queryKey: ['ds-readiness', dataSourceId],
        queryFn: () => aggregationService.getReadiness(dataSourceId),
        staleTime: 30_000,
    })
    if (!data) return null
    return (
        <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
                <Waypoints className="w-4 h-4 text-ink-muted" />
                <h3 className="text-sm font-bold text-ink">Aggregation</h3>
            </div>
            <div className="space-y-1.5 text-xs">
                <DetailRow label="Status" value={data.aggregationStatus ?? '—'} />
                <DetailRow label="Rolled-up edges" value={compactNum(data.aggregationEdgeCount ?? 0)} />
                <DetailRow label="Last aggregated" value={timeAgo(data.lastAggregatedAt)} />
                {data.driftDetected && (
                    <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        Source changed since last aggregation — re-aggregate from the workspace to refresh.
                    </p>
                )}
            </div>
        </Card>
    )
}

// ── component ────────────────────────────────────────────────────────────

export function DataSourceProfile({ catalogId, context }: {
    catalogId: string
    context?: DataSourceProfileContext | null
}) {
    const { item, provider, stats, meta, consumers, statsLoading, consumersLoading, notFound } = useDataSourceProfile(catalogId)

    const health = useProviderHealth(item?.providerId)
    const healthMeta = PROVIDER_HEALTH_META[health.state]

    const ProviderLogo = getProviderLogo(provider?.providerType ?? 'falkordb')
    const tint = PROVIDER_TINT[provider?.providerType ?? 'falkordb'] ?? PROVIDER_TINT.falkordb
    const conn = connectivity(stats?.nodeCount ?? 0, stats?.edgeCount ?? 0)

    // Lineage is workspace/view-scoped in this app (no standalone canvas),
    // so we route into the Explorer filtered to a workspace that USES this
    // source. A catalog item can map to several workspaces; the hero links
    // to the first and the Explore card lists them all.
    const workspaces = consumers?.workspaces ?? []
    const explorerHrefFor = (wsId: string) => `/explorer?workspace=${wsId}`
    const primaryExplorerHref = workspaces[0] ? explorerHrefFor(workspaces[0].id) : null

    if (notFound) {
        return (
            <Card className="p-12 text-center">
                <Database className="w-10 h-10 mx-auto opacity-20 mb-3" />
                <p className="text-sm font-semibold text-ink">Data source not found</p>
                <p className="text-xs text-ink-muted mt-1">It may have been unregistered.</p>
            </Card>
        )
    }

    return (
        <>
            {/* ── Hero ─────────────────────────────────────────── */}
            <motion.div
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className={cn('relative overflow-hidden rounded-3xl border border-glass-border bg-gradient-to-br', tint.split(' ').slice(0, 2).join(' '))}
            >
                <div className="absolute inset-0 bg-canvas-elevated/60" />
                <div className="relative p-6 md:p-7 flex flex-col md:flex-row md:items-center gap-5">
                    <div className={cn('w-14 h-14 rounded-2xl border border-glass-border bg-canvas flex items-center justify-center shrink-0', tint.split(' ').slice(-1))}>
                        <ProviderLogo className="w-7 h-7" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5 flex-wrap">
                            <h1 className="text-2xl font-black text-ink leading-tight truncate">
                                {item?.name ?? <span className="opacity-40">Loading…</span>}
                            </h1>
                            <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', healthMeta.dot)} title={healthMeta.label} />
                            {meta && <StatusChip meta={meta} compact />}
                        </div>
                        <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-muted flex-wrap">
                            <span className="inline-flex items-center gap-1.5">
                                <Database className="w-3.5 h-3.5" />
                                {provider?.name ?? '—'}
                            </span>
                            {item?.sourceIdentifier && (
                                <span className="font-mono text-ink-muted/80">{item.sourceIdentifier}</span>
                            )}
                            {meta?.updated_at && (
                                <span className="inline-flex items-center gap-1">
                                    <Clock className="w-3 h-3" /> Refreshed {timeAgo(meta.updated_at)}
                                </span>
                            )}
                        </div>
                    </div>
                    {/* Primary action — the lineage entry the Ingestion area lacked.
                        Disabled until the source is scoped into a workspace, since
                        lineage is explored through a workspace context. */}
                    <div className="flex items-center gap-2 shrink-0">
                        {primaryExplorerHref ? (
                            <Link
                                to={primaryExplorerHref}
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-bold shadow-md shadow-indigo-500/20 transition-colors active:scale-95"
                            >
                                <Compass className="w-4 h-4" /> Explore lineage
                            </Link>
                        ) : (
                            <span
                                title="Scope this source into a workspace to explore its lineage"
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 text-ink-muted text-sm font-bold cursor-not-allowed"
                            >
                                <Compass className="w-4 h-4" /> Explore lineage
                            </span>
                        )}
                    </div>
                </div>
            </motion.div>

            {/* ── Metric tiles ─────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                <StatTile icon={Boxes} label="Nodes" value={compactNum(stats?.nodeCount)} tint="bg-indigo-500/10 text-indigo-500" loading={statsLoading} />
                <StatTile icon={Spline} label="Edges" value={compactNum(stats?.edgeCount)} tint="bg-violet-500/10 text-violet-500" loading={statsLoading} />
                <StatTile icon={Tag} label="Entity Types" value={compactNum(stats ? Object.keys(stats.entityTypeCounts).length : undefined)} tint="bg-emerald-500/10 text-emerald-500" loading={statsLoading} />
                <StatTile icon={Waypoints} label="Edge Types" value={compactNum(stats ? Object.keys(stats.edgeTypeCounts).length : undefined)} tint="bg-amber-500/10 text-amber-500" loading={statsLoading} />
            </div>

            {/* ── Body ─────────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
                {/* Left / main */}
                <div className="lg:col-span-2 space-y-4">
                    <Card>
                        <CardHeader icon={Tag} title="Entity types" />
                        {stats ? <TypeBreakdown counts={stats.entityTypeCounts} accent="bg-emerald-500" />
                            : <p className="px-5 pb-5 text-xs text-ink-muted">{statsLoading ? 'Loading…' : 'No stats available.'}</p>}
                    </Card>
                    <Card>
                        <CardHeader icon={Waypoints} title="Relationship types" />
                        {stats ? <TypeBreakdown counts={stats.edgeTypeCounts} accent="bg-amber-500" />
                            : <p className="px-5 pb-5 text-xs text-ink-muted">{statsLoading ? 'Loading…' : 'No stats available.'}</p>}
                    </Card>

                    {/* Quality & connectivity */}
                    <Card className="p-5">
                        <div className="flex items-center gap-2 mb-4">
                            <ShieldCheck className="w-4 h-4 text-ink-muted" />
                            <h3 className="text-sm font-bold text-ink">Shape & connectivity</h3>
                        </div>
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs text-ink-muted">Graph connectivity</span>
                            <span className="text-xs font-bold text-ink">{conn.label}</span>
                        </div>
                        <div className="h-2.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${conn.pct}%` }} />
                        </div>
                        <p className="mt-2 text-[11px] text-ink-muted">
                            {stats ? `${compactNum(stats.edgeCount)} relationships across ${compactNum(stats.nodeCount)} entities` : '—'}
                        </p>
                    </Card>
                </div>

                {/* Right / sidebar */}
                <div className="space-y-4">
                    {/* Used by — freed from the delete dialog */}
                    <Card>
                        <CardHeader icon={Building2} title="Used by" action={
                            consumersLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" /> : undefined
                        } />
                        <div className="px-5 pb-5 space-y-4">
                            <UsedByList
                                icon={Building2} label="Workspaces"
                                items={consumers?.workspaces ?? []}
                                href={(id) => `/workspaces/${id}`}
                                empty="Not scoped into any workspace yet."
                            />
                            <UsedByList
                                icon={Eye} label="Views"
                                items={consumers?.views ?? []}
                                href={(id) => `/views/${id}`}
                                empty="No views reference this source."
                            />
                        </div>
                    </Card>

                    {/* Details */}
                    <Card>
                        <CardHeader icon={Layers} title="Details" />
                        <dl className="px-5 pb-5 space-y-2.5 text-xs">
                            <DetailRow label="Status" value={item?.status ?? '—'} />
                            <DetailRow label="Provider" value={provider?.name ?? '—'} />
                            <DetailRow label="Source identifier" mono value={item?.sourceIdentifier ?? '—'} />
                            <DetailRow label="Registered" value={item ? timeAgo(item.createdAt) : '—'} />
                            {item?.description && <DetailRow label="Description" value={item.description} />}
                        </dl>
                    </Card>

                    {/* Explore lineage — one entry per workspace that uses this source */}
                    <Card className="p-5">
                        <div className="flex items-center gap-2 mb-3">
                            <GitBranch className="w-4 h-4 text-ink-muted" />
                            <h3 className="text-sm font-bold text-ink">Explore lineage</h3>
                        </div>
                        {workspaces.length === 0 ? (
                            <p className="text-xs text-ink-muted/80">
                                Scope this source into a workspace to explore its lineage on the canvas.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {workspaces.map((ws) => (
                                    <Link key={ws.id} to={explorerHrefFor(ws.id)}
                                        className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 text-sm font-semibold text-ink-secondary transition-colors group">
                                        <span className="inline-flex items-center gap-2 min-w-0">
                                            <Compass className="w-4 h-4 shrink-0" />
                                            <span className="truncate">{ws.name}</span>
                                        </span>
                                        <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </Link>
                                ))}
                            </div>
                        )}
                    </Card>

                    {/* ── Enhanced (workspace-context) sections ───────── */}
                    {context && (
                        <>
                            <Card className="p-5">
                                <div className="flex items-center gap-2 mb-3">
                                    <Layers className="w-4 h-4 text-ink-muted" />
                                    <h3 className="text-sm font-bold text-ink">Semantic layer</h3>
                                </div>
                                {context.ontologyId ? (
                                    <Link to={`/schema/${context.ontologyId}`} className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                                        {context.ontologyName ?? 'View ontology'}
                                    </Link>
                                ) : (
                                    <p className="text-xs text-ink-muted/80">No semantic layer assigned.</p>
                                )}
                            </Card>

                            <AggregationStatusCard dataSourceId={context.dataSourceId} wsId={context.wsId} />

                            <VocabAlignmentWarning wsId={context.wsId} dataSourceId={context.dataSourceId} />
                        </>
                    )}
                </div>
            </div>
        </>
    )
}
