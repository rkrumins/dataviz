/**
 * StreamsPanel — every Redis Stream (aggregation + insights families),
 * their DLQs, and the transactional-outbox relay in one delivery table:
 * depth, pending, oldest-pending age, consumer-group lag, consumers.
 */
import { Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OutboxSection, StreamDepth, StreamsSection } from '@/services/systemStatusService'
import { compactNum, formatAgeMs } from './meta'
import { Sparkline } from './Sparkline'

interface Props {
    streams: StreamsSection | null
    outbox: OutboxSection | null
    history: Map<string, number[]>
}

interface Row {
    name: string
    lane?: string
    depth: StreamDepth | null
    dlqLen?: number | null
    dlqOldestMs?: number | null
    isDlq?: boolean
    historyKey?: string
}

function buildRows(streams: StreamsSection): Row[] {
    const rows: Row[] = [{
        name: 'aggregation.jobs',
        depth: streams.aggregation.jobs,
        historyKey: 'stream:aggregation.jobs',
    }]
    for (const [name, depth] of Object.entries(streams.insights.streams)) {
        rows.push({ name, lane: depth.lane, depth, historyKey: `stream:${name}` })
    }
    rows.push({
        name: 'aggregation.jobs.dlq', isDlq: true, depth: null,
        dlqLen: streams.aggregation.dlq.len, dlqOldestMs: streams.aggregation.dlq.oldestAgeMs,
    })
    rows.push({
        name: 'insights.dlq', isDlq: true, depth: null,
        dlqLen: streams.insights.dlq.len, dlqOldestMs: streams.insights.dlq.oldestAgeMs,
    })
    return rows
}

const LANE_CLS: Record<string, string> = {
    fast: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    heavy: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
    purge: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted',
}

function Num({ value }: { value: number | null | undefined }) {
    return <span className="tabular-nums">{value == null ? '—' : compactNum(value)}</span>
}

export function StreamsPanel({ streams, outbox, history }: Props) {
    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <Waypoints className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Delivery pipelines</h2>
                    <p className="text-[11px] text-ink-muted">Redis Streams queue depth and consumer lag, plus the outbox relay.</p>
                </div>
            </div>

            {!streams ? (
                <p className="px-5 pb-4 text-xs text-ink-muted">Stream state unavailable.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-black/5 dark:bg-white/5">
                            <tr className="text-left text-[10px] uppercase tracking-wider text-ink-muted">
                                <th className="px-5 py-2 font-semibold">Stream</th>
                                <th className="px-3 py-2 font-semibold text-right">Depth</th>
                                <th className="px-3 py-2 font-semibold text-right">Pending</th>
                                <th className="px-3 py-2 font-semibold text-right">Oldest pending</th>
                                <th className="px-3 py-2 font-semibold text-right">Lag</th>
                                <th className="px-3 py-2 font-semibold text-right">Consumers</th>
                                <th className="px-5 py-2 font-semibold text-right">Trend</th>
                            </tr>
                        </thead>
                        <tbody>
                            {buildRows(streams).map((row) => {
                                const dlqHot = row.isDlq && (row.dlqLen ?? 0) > 0
                                return (
                                    <tr key={row.name} className={cn(
                                        'border-t border-glass-border transition-colors',
                                        dlqHot && 'bg-red-500/5',
                                    )}>
                                        <td className="px-5 py-2.5">
                                            <span className={cn('font-mono text-[11px]',
                                                dlqHot ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-ink-secondary')}>
                                                {row.name}
                                            </span>
                                            {row.lane && (
                                                <span className={cn('ml-2 inline-flex px-1.5 py-px rounded-full border text-[9px] font-medium uppercase tracking-wide', LANE_CLS[row.lane] ?? LANE_CLS.purge)}>
                                                    {row.lane}
                                                </span>
                                            )}
                                        </td>
                                        <td className={cn('px-3 py-2.5 text-right', dlqHot && 'text-red-600 dark:text-red-400 font-semibold')}>
                                            <Num value={row.isDlq ? row.dlqLen : row.depth?.len} />
                                        </td>
                                        <td className="px-3 py-2.5 text-right"><Num value={row.depth?.pending} /></td>
                                        <td className="px-3 py-2.5 text-right text-ink-muted whitespace-nowrap">
                                            {formatAgeMs(row.isDlq ? row.dlqOldestMs : row.depth?.oldestPendingAgeMs) ?? '—'}
                                        </td>
                                        <td className="px-3 py-2.5 text-right"><Num value={row.depth?.groupLag} /></td>
                                        <td className="px-3 py-2.5 text-right"><Num value={row.depth?.consumers} /></td>
                                        <td className="px-5 py-2.5 text-right">
                                            {row.historyKey && history.get(row.historyKey) ? (
                                                <Sparkline points={history.get(row.historyKey)!} width={64} height={16} className="inline-block" />
                                            ) : <span className="text-ink-muted">—</span>}
                                        </td>
                                    </tr>
                                )
                            })}
                            {/* Outbox relay — the other delivery pipeline (Postgres → audit log). */}
                            <tr className={cn('border-t border-glass-border',
                                outbox && outbox.pending > 0 && 'bg-amber-500/5')}>
                                <td className="px-5 py-2.5">
                                    <span className="font-mono text-[11px] text-ink-secondary">outbox relay</span>
                                    <span className="ml-2 inline-flex px-1.5 py-px rounded-full border border-glass-border bg-black/5 dark:bg-white/5 text-[9px] uppercase tracking-wide text-ink-muted">
                                        postgres
                                    </span>
                                </td>
                                <td className="px-3 py-2.5 text-right"><Num value={outbox?.pending} /></td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                <td className="px-3 py-2.5 text-right text-ink-muted whitespace-nowrap">
                                    {outbox?.oldestPendingAgeS != null ? formatAgeMs(outbox.oldestPendingAgeS * 1000) : '—'}
                                </td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">
                                    {outbox?.relayAlive == null ? '—' : outbox.relayAlive ? 'relay live' : 'relay dead'}
                                </td>
                                <td className="px-5 py-2.5 text-right text-ink-muted">—</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}
