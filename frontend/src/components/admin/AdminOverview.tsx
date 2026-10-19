/**
 * AdminOverview — The global health dashboard.
 * Merges the navigational landing page with system-wide Insights.
 *
 * Its numbers are the workspace summary's — the one server-side definition the
 * Dashboard and the Workspaces page read too. It used to add up the bulk stats
 * response itself while the Dashboard did the same from a stale workspace list,
 * and the two pages quoted different totals for the same estate.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
    CircleDot, ArrowRightLeft, Database, Layers, Server,
    Activity, Plus, Shield, Loader2, Share2, AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { providerService } from '@/services/providerService'
import { useWorkspaceSummary } from '@/hooks/useWorkspaceSummary'
import { PageContainer } from '@/components/layout/PageContainer'

const KPI_CONFIG = [
    { key: 'nodes', label: 'Total Nodes', icon: CircleDot, gradient: 'from-indigo-500/20 to-indigo-500/0', accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
    { key: 'edges', label: 'Total Edges', icon: ArrowRightLeft, gradient: 'from-violet-500/20 to-violet-500/0', accent: 'text-violet-600 dark:text-violet-400', iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20' },
    { key: 'sources', label: 'Data Sources', icon: Database, gradient: 'from-emerald-500/20 to-emerald-500/0', accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
    { key: 'types', label: 'Entity Types', icon: Layers, gradient: 'from-amber-500/20 to-amber-500/0', accent: 'text-amber-600 dark:text-amber-400', iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
]

export function AdminOverview() {
    const navigate = useNavigate()
    // React Query keeps the last answer when a refresh fails, so a slow or
    // failing request shows the previous counts — never a fleet of zeros.
    const { summary, isLoading, error } = useWorkspaceSummary()
    const { data: providers } = useQuery({
        queryKey: ['providers', 'list'],
        queryFn: () => providerService.list(),
        staleTime: 30_000,
    })

    const totals = summary?.totals
    const rows = [...(summary?.workspaces ?? [])].sort((a, b) => b.nodes - a.nodes)
    const kpiValues: Record<string, number> = {
        nodes: totals?.nodes ?? 0,
        edges: totals?.edges ?? 0,
        sources: totals?.dataSources ?? 0,
        types: totals?.entityTypes.length ?? 0,
    }

    if (isLoading && !summary) {
        return (
            <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
                {/* Header */}
                <div className="flex items-center justify-between mb-10">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="space-y-2">
                            <div className="h-8 w-48 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse" />
                            <div className="h-4 w-72 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        </div>
                    </div>
                </div>

                {/* KPI cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="border border-glass-border rounded-xl p-5 bg-canvas-elevated">
                            <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse mb-3" />
                            <div className="h-7 w-16 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                            <div className="h-3 w-20 rounded bg-black/5 dark:bg-white/10 animate-pulse mt-2" />
                        </div>
                    ))}
                </div>

                {/* Per-workspace table */}
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    <div className="px-5 py-3 border-b border-glass-border bg-black/5 dark:bg-white/5">
                        <div className="h-4 w-32 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                    </div>
                    {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="flex items-center justify-between px-5 py-3 border-b last:border-b-0 border-glass-border">
                            <div className="h-4 w-40 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                            <div className="flex items-center gap-8">
                                <div className="h-4 w-10 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                                <div className="h-4 w-10 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                                <div className="h-4 w-10 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                            </div>
                        </div>
                    ))}
                </div>
            </PageContainer>
        )
    }

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            {error && !summary && (
                <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-sm text-ink">
                        The overview couldn't be loaded. These counts are unknown, not zero — try again in a moment.
                    </p>
                </div>
            )}
            {/* Header */}
            <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <Shield className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink">Global Overview</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            System health, graph scale, and cross-workspace analytics.
                        </p>
                    </div>
                </div>

                <div className="flex gap-3">
                    <button
                        onClick={() => navigate('/ingestion?tab=providers')}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2"
                    >
                        <Server className="w-4 h-4" /> Register Connection
                    </button>
                    <button
                        onClick={() => navigate('/workspaces')}
                        className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl font-medium text-sm transition-colors flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" /> Create Workspace
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {KPI_CONFIG.map(kpi => {
                    const Icon = kpi.icon
                    return (
                        <div key={kpi.key} className={cn(
                            "relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated",
                            "hover:shadow-lg transition-all duration-200"
                        )}>
                            <div className={cn("absolute inset-0 bg-gradient-to-br", kpi.gradient)} />
                            <div className="relative">
                                <div className={cn("w-9 h-9 rounded-lg border flex items-center justify-center mb-3", kpi.iconBg)}>
                                    <Icon className="w-4.5 h-4.5" />
                                </div>
                                <p className={cn("text-2xl font-bold tabular-nums", kpi.accent)}>
                                    {totals ? compact(kpiValues[kpi.key]) : '—'}
                                </p>
                                <p className="text-xs text-ink-muted mt-1">{kpi.label}</p>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* System Breakdown */}
            <div className="flex items-center gap-4 mb-6 flex-wrap">
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                    <Server className="w-4 h-4 text-ink-muted" />
                    <span className="text-sm text-ink"><span className="font-bold">{providers?.length ?? '—'}</span> Physical Connections</span>
                </div>
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                    <Activity className="w-4 h-4 text-ink-muted" />
                    <span className="text-sm text-ink"><span className="font-bold">{totals?.workspaces ?? '—'}</span> Isolated Workspaces</span>
                </div>
                {(totals?.pendingDataSources ?? 0) > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/5 border border-amber-500/20">
                        <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
                        <span className="text-sm text-ink">
                            Counting <span className="font-bold">{totals?.pendingDataSources}</span> source{totals?.pendingDataSources === 1 ? '' : 's'} — totals fill in on their own
                        </span>
                    </div>
                )}
                {(totals?.sharedGraphs ?? 0) > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <Share2 className="w-4 h-4 text-ink-muted" />
                        <span className="text-sm text-ink">
                            A graph used by several workspaces is counted once in the totals
                        </span>
                    </div>
                )}
            </div>

            {/* Per-workspace breakdown table */}
            {rows.length > 0 && (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    <table className="w-full">
                        <thead className="bg-black/5 dark:bg-white/5">
                            <tr className="border-b border-glass-border">
                                <th className="text-left text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Workspace</th>
                                <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Sources</th>
                                <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Nodes</th>
                                <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Edges</th>
                                <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-5 py-3">Entity Types</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, i) => (
                                <tr key={row.id} onClick={() => navigate(`/workspaces/${row.id}`)} className={cn("border-b last:border-b-0 border-glass-border hover:bg-black/[0.05] dark:hover:bg-white/[0.05] cursor-pointer transition-colors", i % 2 === 0 && "bg-black/[0.01] dark:bg-white/[0.01]")}>
                                    <td className="px-5 py-3">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold text-ink">{row.name}</span>
                                            {row.isDefault && (
                                                <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-indigo-500/10 text-indigo-500">DEFAULT</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-5 py-3 text-right text-sm text-ink-secondary font-medium">{row.dataSources}</td>
                                    <td className="px-5 py-3 text-right">
                                        <span className="text-sm font-bold text-indigo-500 tabular-nums">{compact(row.nodes)}</span>
                                    </td>
                                    <td className="px-5 py-3 text-right">
                                        <span className="text-sm font-bold text-violet-500 tabular-nums">{compact(row.edges)}</span>
                                    </td>
                                    <td className="px-5 py-3 text-right text-sm text-ink-secondary font-medium">{row.entityTypes.length}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* Entity type aggregate */}
                    <div className="px-5 py-4 border-t border-glass-border bg-canvas-elevated">
                        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2"><Layers className="w-3.5 h-3.5 text-amber-500" /> Enterprise Data Model</h4>
                        <div className="flex flex-wrap gap-1.5">
                            {(totals?.entityTypes ?? []).map(type => (
                                <span key={type} className="px-2.5 py-1 text-[11px] font-medium rounded-full bg-amber-500/5 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                    {type}
                                </span>
                            ))}
                            {(totals?.entityTypes.length ?? 0) === 0 && <span className="text-xs text-ink-muted">No entity types discovered</span>}
                        </div>
                    </div>
                </div>
            )}
        </PageContainer>
    )
}
