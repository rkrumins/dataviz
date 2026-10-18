/**
 * NeedsAttention — the few profiling findings worth a look, on the Dashboard.
 *
 * Profiling already notices when a source moves far beyond its usual range,
 * when an entity type disappears, or when a source goes silent — but only on the
 * Ingestion page, where nobody who just opened the app will see it. The
 * Dashboard's numbers can read "All sources active" while a graph lost half its
 * entities on Tuesday; this strip is where that reaches the people who can look.
 *
 * Shown only to readers of profiling (the same gate as the Ingestion tab) and
 * only while something is open. The worst three, then a way to the rest.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Check, EyeOff, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import { PROFILING_KEY, useProfilingFindings } from '@/hooks/useProfiling'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import { profilingService } from '@/services/profilingService'
import { useWorkspacesStore } from '@/store/workspaces'
import type { Finding } from '@/types/profiling'
import { metricNoun, significanceMeta } from '@/components/ingestion/profiling/shared'

const ICON = { movement: AlertTriangle, type_gone: EyeOff, silent: Radio }
const SHOWN = 3

/** One line, checkable: what moved, against what is usual for this source. */
function findingHeadline(f: Finding): string {
    const noun = metricNoun(f.metric, f.delta)
    if (f.finding === 'silent') return 'Stopped reporting — nothing has been measured since.'
    if (f.finding === 'type_gone') {
        return `Every ${f.subject_type ?? 'entity'} is gone (${exact(Math.abs(f.delta))} ${noun}).`
    }
    const sign = f.delta < 0 ? '−' : '+'
    return `${sign}${exact(Math.abs(f.delta))} ${noun}, against a usual movement of ${exact(f.baseline)}.`
}

/** Worst first, then the most recent. */
function rankFindings(findings: readonly Finding[]): Finding[] {
    return [...findings].sort((a, b) =>
        significanceMeta(b.severity).rank - significanceMeta(a.severity).rank
        || b.detected_at.localeCompare(a.detected_at))
}

export function NeedsAttention() {
    const canRead = useCanReadProfiling()
    const { data } = useProfilingFindings({ openOnly: true, limit: 50 }, { enabled: canRead })
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const queryClient = useQueryClient()
    const [busy, setBusy] = useState<string | null>(null)

    const open = data?.alerts.filter(f => !f.acknowledged_at) ?? []
    if (!canRead || open.length === 0) return null
    const shown = rankFindings(open).slice(0, SHOWN)
    const total = data?.openCount ?? open.length

    const markSeen = async (id: string) => {
        setBusy(id)
        try {
            await profilingService.acknowledge(id)
            await queryClient.invalidateQueries({ queryKey: [PROFILING_KEY, 'findings'] })
        } finally {
            setBusy(null)
        }
    }

    return (
        <section aria-labelledby="needs-attention" className="mb-14 px-4 md:px-0">
            <div className="flex items-end justify-between gap-4 mb-4">
                <div>
                    <h2 id="needs-attention" className="text-lg font-bold text-ink flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-500" aria-hidden />
                        Needs attention
                        <span className="text-xs font-semibold text-rose-600 dark:text-rose-300 bg-rose-500/10 rounded-full px-2 py-0.5 tabular-nums">
                            {total}
                        </span>
                    </h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                        Sources that moved far beyond what is usual for them, lost a type, or went quiet.
                    </p>
                </div>
                {total > shown.length && (
                    <Link
                        to="/ingestion?tab=profiling"
                        className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        View all {total} <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                    </Link>
                )}
            </div>
            <ul className="glass-panel rounded-2xl border border-rose-500/20 divide-y divide-glass-border overflow-hidden">
                {shown.map(f => {
                    const meta = significanceMeta(f.severity)
                    const Icon = ICON[f.finding] ?? AlertTriangle
                    const source = f.data_source_label || f.graph_name || f.data_source_id
                    const workspace = workspaces.find(w => w.id === f.workspace_id)?.name
                    return (
                        <li key={f.id} className="flex items-start gap-3 px-4 py-3">
                            <span className={cn('mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-rose-500/10', meta.tone)}>
                                <Icon className="w-4 h-4" aria-hidden />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-baseline gap-x-2">
                                    <span className={cn('text-[11px] font-bold uppercase tracking-wide', meta.tone)}>{meta.label}</span>
                                    <span className="text-sm font-semibold text-ink truncate">{source}</span>
                                    {workspace && <span className="text-xs text-ink-muted">in {workspace}</span>}
                                </p>
                                <p className="text-xs text-ink-secondary mt-0.5">{findingHeadline(f)}</p>
                                <p className="text-[11px] text-ink-muted mt-0.5">Noticed {timeAgo(f.detected_at)}</p>
                            </div>
                            <div className="shrink-0 flex items-center gap-1.5">
                                <Link
                                    to={`/ingestion?tab=profiling&source=${encodeURIComponent(f.data_source_id)}`}
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10"
                                >
                                    Open
                                </Link>
                                <button
                                    type="button"
                                    disabled={busy === f.id}
                                    onClick={() => void markSeen(f.id)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-secondary border border-glass-border hover:text-ink hover:bg-canvas disabled:opacity-50"
                                >
                                    <Check className="w-3.5 h-3.5" aria-hidden />
                                    {busy === f.id ? 'Marking…' : 'Mark seen'}
                                </button>
                            </div>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
