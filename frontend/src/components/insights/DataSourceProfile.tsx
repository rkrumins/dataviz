/**
 * DataSourceProfile — the reusable core of a data source's picture.
 *
 * Rendered in three contexts of very different widths: the full page, the
 * Ingestion slide-over (~672px), and the Workspaces detail drawer (~440px).
 * The app has no container-query plugin, so viewport breakpoints (`lg:`)
 * can't tell how wide the *container* is — a 4-col grid would get forced
 * into a narrow drawer. So the layout is deliberately SINGLE-COLUMN and
 * overflow-proof: it reads well and never truncates at any width. The page
 * wrapper constrains it to a comfortable reading column.
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
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-3">
            <div className="flex items-center gap-2 min-w-0">
                <Icon className="w-4 h-4 text-ink-muted shrink-0" />
                <h3 className="text-sm font-bold text-ink truncate">{title}</h3>
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
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-3.5 flex items-center gap-3 min-w-0">
            <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', tint)}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
                <p className="text-xl font-black text-ink leading-none tabular-nums truncate">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin text-ink-muted" /> : value}
                </p>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mt-1.5 truncate">{label}</p>
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
                <div key={name} className="flex items-center gap-3 min-w-0">
                    <span className="w-24 sm:w-32 shrink-0 truncate text-xs font-medium text-ink-secondary" title={name}>{name}</span>
                    <div className="flex-1 min-w-0 h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                        <div className={cn('h-full rounded-full', accent)} style={{ width: `${Math.max(3, (count / rows.max) * 100)}%` }} />
                    </div>
                    <span className="w-12 shrink-0 text-right text-xs font-bold text-ink tabular-nums">{compactNum(count)}</span>
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
            <dd className={cn('text-ink text-right min-w-0', mono ? 'font-mono text-ink-secondary break-all' : 'break-words')}>{value}</dd>
        </div>
    )
}

function UsedByList({ icon: Icon, label, items, href, empty, currentId, onItemClick }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    items: Array<{ id: string; name: string }>
    href: (id: string) => string
    empty: string
    /** Marks the item the viewer is currently inside (e.g. the workspace the
     *  drawer is open in) so a same-page link isn't a silent no-op. */
    currentId?: string
    /** Called on click so a host (the drawer) can close itself — otherwise a
     *  link to the page you're already on does nothing visible. */
    onItemClick?: () => void
}) {
    return (
        <div>
            <div className="flex items-center gap-1.5 mb-2">
                <Icon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">{label}</span>
                <span className="text-[11px] font-bold text-ink-muted tabular-nums">· {items.length}</span>
            </div>
            {items.length === 0 ? (
                <p className="text-xs text-ink-muted/80">{empty}</p>
            ) : (
                <div className="space-y-1">
                    {items.map((it) => (
                        <Link key={it.id} to={href(it.id)} onClick={() => onItemClick?.()}
                            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-sm text-ink-secondary hover:text-ink transition-colors group">
                            <span className="truncate">
                                {it.name}
                                {it.id === currentId && <span className="text-ink-muted/70 font-normal"> · you're here</span>}
                            </span>
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
                <Waypoints className="w-4 h-4 text-ink-muted shrink-0" />
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

export function DataSourceProfile({ catalogId, context, embedded, onNavigate }: {
    catalogId: string
    context?: DataSourceProfileContext | null
    /** True when a host already shows the source's identity + actions (the
     *  workspace drawer header). Suppresses the profile's own hero, explore
     *  card, semantic-layer link and vocab warning so nothing is duplicated. */
    embedded?: boolean
    /** Called when an internal link is followed, so a host drawer can close
     *  itself (a link to the page you're already on is otherwise a no-op). */
    onNavigate?: () => void
}) {
    const { item, provider, stats, meta, consumers, statsLoading, consumersLoading, notFound } = useDataSourceProfile(catalogId)

    const health = useProviderHealth(item?.providerId)
    const healthMeta = PROVIDER_HEALTH_META[health.state]

    const ProviderLogo = getProviderLogo(provider?.providerType ?? 'falkordb')
    const tint = PROVIDER_TINT[provider?.providerType ?? 'falkordb'] ?? PROVIDER_TINT.falkordb
    const conn = connectivity(stats?.nodeCount ?? 0, stats?.edgeCount ?? 0)

    const workspaces = consumers?.workspaces ?? []
    const views = consumers?.views ?? []
    // Lineage is workspace/view-scoped (no standalone canvas). In a workspace
    // context we scope the Explorer to THIS data source (same link the
    // workspace drawer uses); otherwise we can only route to a consuming
    // workspace's Explorer, and we make which workspace explicit.
    const contextWorkspaceName = context ? (workspaces.find(w => w.id === context.wsId)?.name ?? null) : null
    const explorerHref = context
        ? `/explorer?workspace=${context.wsId}&dataSource=${context.dataSourceId}`
        : (workspaces[0] ? `/explorer?workspace=${workspaces[0].id}` : null)

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
        <div className="min-w-0 space-y-4">
            {/* ── Hero — suppressed when embedded (the host header already
                shows identity + actions). ─────────────────────── */}
            {!embedded && (
            <motion.div
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className={cn('relative overflow-hidden rounded-3xl border border-glass-border bg-gradient-to-br', tint.split(' ').slice(0, 2).join(' '))}
            >
                <div className="absolute inset-0 bg-canvas-elevated/60" />
                <div className="relative p-5 sm:p-6 flex flex-col gap-4">
                    <div className="flex items-start gap-4 min-w-0">
                        <div className={cn('w-12 h-12 rounded-2xl border border-glass-border bg-canvas flex items-center justify-center shrink-0', tint.split(' ').slice(-1))}>
                            <ProviderLogo className="w-6 h-6" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h1 className="text-xl font-black text-ink leading-tight break-words">
                                    {item?.name ?? <span className="opacity-40">Loading…</span>}
                                </h1>
                                <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', healthMeta.dot)} title={healthMeta.label} />
                                {meta && <StatusChip meta={meta} compact />}
                            </div>
                            <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 text-xs text-ink-muted flex-wrap">
                                <span className="inline-flex items-center gap-1.5 min-w-0">
                                    <Database className="w-3.5 h-3.5 shrink-0" />
                                    <span className="truncate">{provider?.name ?? '—'}</span>
                                </span>
                                {item?.sourceIdentifier && (
                                    <span className="font-mono text-ink-muted/80 break-all">{item.sourceIdentifier}</span>
                                )}
                                {meta?.updated_at && (
                                    <span className="inline-flex items-center gap-1 shrink-0">
                                        <Clock className="w-3 h-3 shrink-0" /> Refreshed {timeAgo(meta.updated_at)}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    {/* Primary action — lineage. Disabled until the source is
                        scoped into a workspace (lineage is explored there). */}
                    {explorerHref ? (
                        <Link
                            to={explorerHref}
                            className="inline-flex items-center justify-center gap-2 self-start px-4 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-bold shadow-md shadow-indigo-500/20 transition-colors active:scale-95"
                        >
                            <Compass className="w-4 h-4 shrink-0" />
                            <span className="truncate">Explore lineage{contextWorkspaceName ? ` in ${contextWorkspaceName}` : ''}</span>
                        </Link>
                    ) : (
                        <span
                            title="Scope this source into a workspace to explore its lineage"
                            className="inline-flex items-center gap-2 self-start px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 text-ink-muted text-sm font-bold cursor-not-allowed"
                        >
                            <Compass className="w-4 h-4 shrink-0" /> Explore lineage
                        </span>
                    )}
                </div>
            </motion.div>
            )}

            {/* ── Metric tiles — always 2-up, never overflows ──── */}
            <div className="grid grid-cols-2 gap-3">
                <StatTile icon={Boxes} label="Nodes" value={compactNum(stats?.nodeCount)} tint="bg-indigo-500/10 text-indigo-500" loading={statsLoading} />
                <StatTile icon={Spline} label="Edges" value={compactNum(stats?.edgeCount)} tint="bg-violet-500/10 text-violet-500" loading={statsLoading} />
                <StatTile icon={Tag} label="Entity Types" value={compactNum(stats ? Object.keys(stats.entityTypeCounts).length : undefined)} tint="bg-emerald-500/10 text-emerald-500" loading={statsLoading} />
                <StatTile icon={Waypoints} label="Edge Types" value={compactNum(stats ? Object.keys(stats.edgeTypeCounts).length : undefined)} tint="bg-amber-500/10 text-amber-500" loading={statsLoading} />
            </div>

            {/* ── What's inside ────────────────────────────────── */}
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

            {/* ── Shape & connectivity ─────────────────────────── */}
            <Card className="p-5">
                <div className="flex items-center gap-2 mb-4">
                    <ShieldCheck className="w-4 h-4 text-ink-muted shrink-0" />
                    <h3 className="text-sm font-bold text-ink">Shape & connectivity</h3>
                </div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
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

            {/* ── Enhanced (workspace-context): aggregation + vocab ── */}
            {context && <AggregationStatusCard dataSourceId={context.dataSourceId} wsId={context.wsId} />}
            {/* Vocab warning: the workspace drawer already shows it in its
                header, so only render it in the standalone (non-embedded) view. */}
            {context && !embedded && <VocabAlignmentWarning wsId={context.wsId} dataSourceId={context.dataSourceId} />}

            {/* ── Where it's used ──────────────────────────────── */}
            <Card>
                <CardHeader icon={Building2} title="Used by" action={
                    consumersLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" /> : undefined
                } />
                <div className="px-5 pb-5 space-y-4">
                    <UsedByList
                        icon={Building2} label="Workspaces"
                        items={workspaces}
                        href={(id) => `/workspaces/${id}`}
                        empty="Not scoped into any workspace yet."
                        currentId={context?.wsId}
                        onItemClick={onNavigate}
                    />
                    <UsedByList
                        icon={Eye} label="Views"
                        items={views}
                        href={(id) => `/views/${id}`}
                        empty="No views reference this source."
                        onItemClick={onNavigate}
                    />
                </div>
            </Card>

            {/* ── Explore lineage — suppressed when embedded (host header
                has an Explorer action). ─────────────────────── */}
            {!embedded && (
            <Card className="p-5">
                <div className="flex items-center gap-2 mb-3">
                    <GitBranch className="w-4 h-4 text-ink-muted shrink-0" />
                    <h3 className="text-sm font-bold text-ink">Explore lineage</h3>
                </div>
                {context && explorerHref ? (
                    // Workspace context: one clear, data-source-scoped entry.
                    <Link to={explorerHref}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 text-sm font-semibold text-ink-secondary transition-colors group">
                        <span className="inline-flex items-center gap-2 min-w-0">
                            <Compass className="w-4 h-4 shrink-0" />
                            <span className="truncate">Open in Explorer{contextWorkspaceName ? ` — ${contextWorkspaceName}` : ''}</span>
                        </span>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </Link>
                ) : workspaces.length === 0 ? (
                    <p className="text-xs text-ink-muted/80">
                        Scope this source into a workspace to explore its lineage on the canvas.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {workspaces.map((ws) => (
                            <Link key={ws.id} to={`/explorer?workspace=${ws.id}`}
                                className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 text-sm font-semibold text-ink-secondary transition-colors group">
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
            )}

            {/* ── Semantic layer — suppressed when embedded (host header
                shows the ontology chip). ─────────────────────── */}
            {context && !embedded && (
                <Card className="p-5">
                    <div className="flex items-center gap-2 mb-3">
                        <Layers className="w-4 h-4 text-ink-muted shrink-0" />
                        <h3 className="text-sm font-bold text-ink">Semantic layer</h3>
                    </div>
                    {context.ontologyId ? (
                        <Link to={`/schema/${context.ontologyId}`} className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline break-words">
                            {context.ontologyName ?? 'View ontology'}
                        </Link>
                    ) : (
                        <p className="text-xs text-ink-muted/80">No semantic layer assigned.</p>
                    )}
                </Card>
            )}

            {/* ── Details ──────────────────────────────────────── */}
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
        </div>
    )
}
