/**
 * ProjectionPanel — global source-of-truth → read-cache projection health.
 * Rollup chips + a worst-lag table that names each graph (data-source label
 * + workspace), shows how far behind it is, which provider hosts its cache,
 * and any error. Rows deep-link to the workspace where a rebuild lives.
 */
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphProvider, ProjectionSection } from '@/services/systemStatusService'
import { providerLabel } from '@/services/providerTypes'
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

const KIND_LABEL: Record<string, string> = {
    manual: 'Manual', authoritative: 'Authoritative', hybrid: 'Hybrid', blank: 'Blank',
}

interface Props {
    projection: ProjectionSection | null
    providers: GraphProvider[] | null
}

export function ProjectionPanel({ projection, providers }: Props) {
    const navigate = useNavigate()
    const providerById = new Map((providers ?? []).map(p => [p.id, p]))

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-indigo-500" />
                    <div>
                        <h2 className="text-sm font-semibold text-ink">Versioned graph projection</h2>
                        <p className="text-[11px] text-ink-muted">Postgres is the source of truth; each graph is projected into a read cache the app queries.</p>
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
                                        <th className="px-3 py-2 font-semibold text-right">Behind</th>
                                        <th className="px-3 py-2 font-semibold">State</th>
                                        <th className="px-3 py-2 font-semibold">Read cache</th>
                                        <th className="px-3 py-2 font-semibold">Last projected</th>
                                        <th className="px-5 py-2 font-semibold">Error</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {projection.worst.map((row) => {
                                        const progress = row.progressTotal
                                            ? Math.min(100, Math.round(((row.progressDone ?? 0) / row.progressTotal) * 100))
                                            : null
                                        const name = row.dataSourceLabel ?? row.dataSourceId
                                        const ws = row.workspaceName ?? row.workspaceId
                                        const prov = row.falkorProvider ? providerById.get(row.falkorProvider) : null
                                        const provLabel = prov ? prov.name : (row.falkorProvider ? row.falkorProvider : 'default')
                                        return (
                                            <tr
                                                key={row.graphId}
                                                onClick={() => navigate(`/workspaces/${row.workspaceId}`)}
                                                className="border-t border-glass-border hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors align-top"
                                                title="Open workspace (Data health lives on the view)"
                                            >
                                                <td className="px-5 py-2.5">
                                                    <div className="flex items-center gap-2">
                                                        <span className={cn('truncate max-w-[220px]', row.dataSourceLabel ? 'font-semibold text-ink' : 'font-mono text-[11px] text-ink-secondary')} title={row.dataSourceId}>{name}</span>
                                                        {row.providerType && (
                                                            <span className="inline-flex px-1.5 py-px rounded-full border border-indigo-500/20 bg-indigo-500/10 text-[9px] uppercase tracking-wide text-indigo-600 dark:text-indigo-400 shrink-0">
                                                                {providerLabel(row.providerType)}
                                                            </span>
                                                        )}
                                                        {row.kind && (
                                                            <span className="inline-flex px-1.5 py-px rounded-full border border-glass-border bg-black/5 dark:bg-white/5 text-[9px] uppercase tracking-wide text-ink-muted shrink-0">
                                                                {KIND_LABEL[row.kind] ?? row.kind}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <span className="text-[10px] text-ink-muted">{ws}{row.providerName ? ` · ${row.providerName}` : ''}</span>
                                                </td>
                                                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                                    <span className="tabular-nums font-semibold text-ink">{row.lag}</span>
                                                    {row.committed != null && (
                                                        <span className="text-[10px] text-ink-muted"> commits<br />{row.projected ?? 0}/{row.committed} applied</span>
                                                    )}
                                                </td>
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
                                                <td className="px-3 py-2.5">
                                                    <span className="text-ink-secondary">{provLabel}</span>
                                                    <br />
                                                    <span className="font-mono text-[10px] text-ink-muted">{row.falkorGraphName ?? 'not yet projected'}</span>
                                                </td>
                                                <td className="px-3 py-2.5 text-ink-muted whitespace-nowrap">{formatSince(row.lastProjectedAt) ?? 'never'}</td>
                                                <td className="px-5 py-2.5 max-w-[220px]">
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
