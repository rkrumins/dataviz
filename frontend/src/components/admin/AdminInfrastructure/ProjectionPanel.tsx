/**
 * ProjectionPanel — global Postgres → FalkorDB projection freshness.
 * Rollup chips (fresh / catching up / rebuilding / failed) + a worst-lag
 * table for the graphs that need attention; rows deep-link to their
 * workspace (the per-graph Data health rebuild lives there).
 */
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProjectionSection } from '@/services/systemStatusService'
import { compactNum, formatSince } from './meta'

const CHIP_DEFS: { key: keyof ProjectionSection; label: string; cls: string; alwaysShow?: boolean }[] = [
    { key: 'fresh', label: 'in sync', cls: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400', alwaysShow: true },
    { key: 'lagging', label: 'catching up', cls: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400' },
    { key: 'projecting', label: 'projecting', cls: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400' },
    { key: 'rebuilding', label: 'rebuilding', cls: 'bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400' },
    { key: 'failed', label: 'failed', cls: 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400' },
    { key: 'evicted', label: 'evicted', cls: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted' },
]

const ROW_STATUS_CLS: Record<string, string> = {
    idle: 'text-amber-600 dark:text-amber-400',
    projecting: 'text-indigo-600 dark:text-indigo-400',
    rebuilding: 'text-violet-600 dark:text-violet-400',
    evicted: 'text-ink-muted',
}

export function ProjectionPanel({ projection }: { projection: ProjectionSection | null }) {
    const navigate = useNavigate()

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-indigo-500" />
                    <div>
                        <h2 className="text-sm font-semibold text-ink">Versioned graph projection</h2>
                        <p className="text-[11px] text-ink-muted">Postgres is the source of truth; FalkorDB is the read cache it feeds.</p>
                    </div>
                </div>
                {projection && (
                    <span className="text-[11px] text-ink-muted shrink-0">
                        {compactNum(projection.totalGraphs)} graphs · max lag {projection.maxLag} commit{projection.maxLag === 1 ? '' : 's'}
                    </span>
                )}
            </div>

            {!projection ? (
                <p className="px-5 pb-4 text-xs text-ink-muted">Projection state unavailable.</p>
            ) : (
                <>
                    <div className="px-5 pb-3 flex flex-wrap gap-1.5">
                        {CHIP_DEFS.map(({ key, label, cls, alwaysShow }) => {
                            const value = projection[key] as number
                            if (!value && !alwaysShow) return null
                            return (
                                <span key={key} className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium', cls)}>
                                    <span className="font-semibold tabular-nums">{compactNum(value)}</span> {label}
                                </span>
                            )
                        })}
                    </div>

                    {projection.worst.length === 0 ? (
                        <div className="px-5 pb-5 flex items-center gap-2 text-xs text-ink-muted">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                            Every graph is projected to its committed head.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead className="bg-black/5 dark:bg-white/5">
                                    <tr className="text-left text-[10px] uppercase tracking-wider text-ink-muted">
                                        <th className="px-5 py-2 font-semibold">Graph</th>
                                        <th className="px-3 py-2 font-semibold text-right">Lag</th>
                                        <th className="px-3 py-2 font-semibold">State</th>
                                        <th className="px-3 py-2 font-semibold">Last projected</th>
                                        <th className="px-5 py-2 font-semibold">Error</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {projection.worst.map((row) => {
                                        const progress = row.progressTotal
                                            ? Math.min(100, Math.round(((row.progressDone ?? 0) / row.progressTotal) * 100))
                                            : null
                                        return (
                                            <tr
                                                key={row.graphId}
                                                onClick={() => navigate(`/workspaces/${row.workspaceId}`)}
                                                className="border-t border-glass-border hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors"
                                                title="Open workspace (Data health lives on the view)"
                                            >
                                                <td className="px-5 py-2.5">
                                                    <span className="font-mono text-[11px] text-ink-secondary">{row.dataSourceId}</span>
                                                    <span className="ml-2 text-[10px] text-ink-muted">{row.workspaceId}</span>
                                                </td>
                                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-ink">{row.lag}</td>
                                                <td className="px-3 py-2.5">
                                                    <span className={cn('font-medium', ROW_STATUS_CLS[row.status] ?? 'text-ink-secondary')}>
                                                        {row.status === 'idle' ? 'queued' : row.status}
                                                    </span>
                                                    {progress != null && (
                                                        <div className="mt-1 h-1 w-24 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                                                            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" style={{ width: `${progress}%` }} />
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-3 py-2.5 text-ink-muted whitespace-nowrap">{formatSince(row.lastProjectedAt) ?? 'never'}</td>
                                                <td className="px-5 py-2.5 max-w-[260px]">
                                                    {row.lastError
                                                        ? <span className="font-mono text-[10px] text-red-600 dark:text-red-400 line-clamp-2 break-all">{row.lastError}</span>
                                                        : <span className="text-ink-muted">—</span>}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}
