/**
 * "What else is writing this shard right now" — the first question during
 * the memory incident, and until now unanswerable from any one page.
 */
import { memo, useMemo } from 'react'
import { HardDrive, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { nodeLoads } from './NodeLoad'
import { jobStage } from './runSteps'
import type { DataSourceMeta } from './shared'

export const NodeLoadPanel = memo(function NodeLoadPanel({ jobs, dsLookup, onSelectJob }: {
    jobs: AggregationJobResponse[]
    dsLookup: Map<string, DataSourceMeta>
    /** Opens the run's row. Nothing happens without it. */
    onSelectJob?: (jobId: string) => void
}) {
    const loads = useMemo(() => nodeLoads(jobs), [jobs])
    if (loads.length === 0) return null
    const shared = loads.some(l => l.shared)
    return (
        <div
            data-testid="node-load"
            className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-4 py-3 space-y-2"
        >
            <div className="flex items-center gap-2">
                <HardDrive className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                    Graph store nodes being written
                </span>
                {shared && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-500">
                        <Users className="w-3 h-3" aria-hidden="true" />
                        sharing
                    </span>
                )}
            </div>
            <div className="space-y-1.5">
                {loads.map(load => (
                    <div key={load.node} className="flex items-start gap-2.5 text-[11px]">
                        <span className={cn(
                            'font-mono tabular-nums shrink-0 w-[136px] truncate',
                            load.shared ? 'text-amber-500 font-semibold' : 'text-ink-secondary',
                        )}>{load.node}</span>
                        <div className="min-w-0 flex-1 flex flex-wrap gap-x-3 gap-y-1">
                            {load.runs.map(run => {
                                const name = dsLookup.get(run.dataSourceId)?.label
                                    ?? run.dataSourceLabel ?? run.dataSourceId
                                const stage = jobStage(run.runStats?.steps, run.currentPhase)
                                return (
                                    <button
                                        key={run.id}
                                        type="button"
                                        onClick={() => onSelectJob?.(run.id)}
                                        className="text-left text-ink-muted hover:text-ink transition-colors truncate max-w-full"
                                        title={`${name} — ${stage.label}`}
                                    >
                                        <span className="text-ink">{name}</span>
                                        <span className="opacity-60">{` · ${stage.label}`}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                ))}
            </div>
            {shared && (
                <p className="text-[10px] text-amber-500/90 leading-relaxed">
                    More than one rebuild is writing one master. They are bounded
                    {' '}— the reservation ledger for memory, two write slots per node,
                    and neither gets the pacing floor while the other is there —
                    but each is slower than it would be alone.
                </p>
            )}
        </div>
    )
})
