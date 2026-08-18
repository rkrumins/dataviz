/**
 * StreamsPanel — every Redis Stream (all families), their DLQs, and the
 * outbox relay in one delivery table: depth, pending, oldest-pending age,
 * consumer-group lag, consumers. Rows are driven entirely by the flat
 * ``streams``/``dlqs`` lists — no family structure is assumed here.
 *
 * A stream with orphaned pending (a dead consumer holding its PEL) is
 * flagged inline and its per-consumer breakdown is expandable.
 */
import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
    OutboxSection, StreamDescriptor, StreamsSection,
} from '@/services/systemStatusService'
import { compactNum, formatAgeMs } from './meta'
import { Sparkline } from '@/components/ui/Sparkline'

interface Props {
    streams: StreamsSection | null
    outbox: OutboxSection | null
    history: Map<string, number[]>
}

const LANE_CLS: Record<string, string> = {
    fast: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    heavy: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
    sweep: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400',
    purge: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted',
}

function Num({ value }: { value: number | null | undefined }) {
    return <span className="tabular-nums">{value == null ? '—' : compactNum(value)}</span>
}

function StreamRow({ s, history }: { s: StreamDescriptor; history?: number[] }) {
    const [open, setOpen] = useState(false)
    const orphaned = s.orphanedPending ?? 0
    const hasDetail = (s.consumerDetail?.length ?? 0) > 0
    return (
        <>
            <tr
                className={cn('border-t border-glass-border transition-colors',
                    hasDetail && 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5',
                    orphaned > 0 && 'bg-amber-500/5')}
                onClick={hasDetail ? () => setOpen(o => !o) : undefined}
            >
                <td className="px-5 py-2.5">
                    <div className="flex items-center gap-1.5">
                        {hasDetail
                            ? (open ? <ChevronDown className="w-3 h-3 text-ink-muted" /> : <ChevronRight className="w-3 h-3 text-ink-muted" />)
                            : <span className="w-3" />}
                        <span className="font-mono text-[11px] text-ink-secondary">{s.name}</span>
                        {s.lane && (
                            <span className={cn('inline-flex px-1.5 py-px rounded-full border text-[9px] font-medium uppercase tracking-wide', LANE_CLS[s.lane] ?? LANE_CLS.purge)}>
                                {s.lane}
                            </span>
                        )}
                        {orphaned > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full border border-amber-500/20 bg-amber-500/10 text-[9px] font-semibold text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="w-2.5 h-2.5" /> {compactNum(orphaned)} orphaned
                            </span>
                        )}
                    </div>
                </td>
                <td className="px-3 py-2.5 text-right"><Num value={s.len} /></td>
                <td className="px-3 py-2.5 text-right"><Num value={s.pending} /></td>
                <td className="px-3 py-2.5 text-right text-ink-muted whitespace-nowrap">{formatAgeMs(s.oldestPendingAgeMs) ?? '—'}</td>
                <td className="px-3 py-2.5 text-right"><Num value={s.groupLag} /></td>
                <td className="px-3 py-2.5 text-right"><Num value={s.consumers} /></td>
                <td className="px-5 py-2.5 text-right">
                    {history && history.length >= 3
                        ? <Sparkline points={history} width={64} height={16} className="inline-block" />
                        : <span className="text-ink-muted">—</span>}
                </td>
            </tr>
            {open && hasDetail && (
                <tr className="bg-black/[0.02] dark:bg-white/[0.02]">
                    <td colSpan={7} className="px-5 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">Consumers ({s.group})</div>
                        <div className="space-y-1">
                            {s.consumerDetail!.map((c, i) => {
                                const dead = (c.idleMs ?? 0) > 5 * 60 * 1000 && c.pending > 0
                                return (
                                    <div key={i} className="flex items-center gap-2 text-[11px]">
                                        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dead ? 'bg-amber-400' : 'bg-emerald-500')} />
                                        <span className="font-mono text-ink-secondary">{c.name}</span>
                                        <span className="text-ink-muted">· {c.pending} pending · idle {formatAgeMs(c.idleMs) ?? '—'}</span>
                                        {dead && <span className="text-amber-600 dark:text-amber-400 font-medium">stranded</span>}
                                    </div>
                                )
                            })}
                        </div>
                    </td>
                </tr>
            )}
        </>
    )
}

export function StreamsPanel({ streams, outbox, history }: Props) {
    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <Waypoints className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Delivery pipelines</h2>
                    <p className="text-[11px] text-ink-muted">Redis Streams queue depth and consumer lag, plus the outbox relay. Expand a row to see its consumers.</p>
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
                            {streams.streams.map(s => (
                                <StreamRow key={s.name} s={s} history={history.get(`stream:${s.name}`)} />
                            ))}
                            {streams.dlqs.map(dlq => {
                                const hot = (dlq.len ?? 0) > 0
                                return (
                                    <tr key={dlq.name} className={cn('border-t border-glass-border', hot && 'bg-red-500/5')}>
                                        <td className="px-5 py-2.5">
                                            <span className={cn('ml-[18px] font-mono text-[11px]', hot ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-ink-secondary')}>{dlq.name}</span>
                                        </td>
                                        <td className={cn('px-3 py-2.5 text-right', hot && 'text-red-600 dark:text-red-400 font-semibold')}><Num value={dlq.len} /></td>
                                        <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                        <td className="px-3 py-2.5 text-right text-ink-muted whitespace-nowrap">{formatAgeMs(dlq.oldestAgeMs) ?? '—'}</td>
                                        <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                        <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                        <td className="px-5 py-2.5 text-right text-ink-muted">—</td>
                                    </tr>
                                )
                            })}
                            {/* Outbox relay — the other delivery pipeline (Postgres → audit log). */}
                            <tr className={cn('border-t border-glass-border', outbox && outbox.pending > 0 && 'bg-amber-500/5')}>
                                <td className="px-5 py-2.5">
                                    <span className="ml-[18px] font-mono text-[11px] text-ink-secondary">outbox relay</span>
                                    <span className="ml-2 inline-flex px-1.5 py-px rounded-full border border-glass-border bg-black/5 dark:bg-white/5 text-[9px] uppercase tracking-wide text-ink-muted">postgres</span>
                                </td>
                                <td className="px-3 py-2.5 text-right"><Num value={outbox?.pending} /></td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                <td className="px-3 py-2.5 text-right text-ink-muted whitespace-nowrap">{outbox?.oldestPendingAgeS != null ? formatAgeMs(outbox.oldestPendingAgeS * 1000) : '—'}</td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">—</td>
                                <td className="px-3 py-2.5 text-right text-ink-muted">{outbox?.relayAlive == null ? '—' : outbox.relayAlive ? 'relay live' : 'relay dead'}</td>
                                <td className="px-5 py-2.5 text-right text-ink-muted">—</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}
