/**
 * One shard: the master that owns a slot range, the replicas standing behind
 * it, how replication is actually going, and every graph that lives there.
 *
 * The shard is the unit an operator acts on — a graph key hashes to a slot,
 * the slot belongs to a shard, and everything about that graph's memory,
 * latency and durability is decided by the three nodes on this card.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphOnShard, GraphStoreShard, ReplicationFinding } from '@/services/graphStoreService'
import { compactBytes, compactEdges, graphStoreLimitsPath, heldByRebuilds } from '../shared/aggregationKnobs'
import { NodeRow } from './NodeRow'
import { GRAPH_ROLE_LABEL, SEVERITY_CHIP, lagLabel, slotRangeLabel } from './meta'

const GRAPHS_COLLAPSED = 12

function Finding({ finding, canAdjustLimits }: { finding: ReplicationFinding; canAdjustLimits?: boolean }) {
    const { search } = useLocation()
    return (
        <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
            <span className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                SEVERITY_CHIP[finding.severity],
            )}>
                {finding.severity === 'critical' ? 'Act now' : finding.severity === 'warn' ? 'Look' : 'Note'}
            </span>
            <span className="text-[11px] text-ink-secondary leading-snug">{finding.text}</span>
            {finding.fix && <span className="text-[11px] text-ink-muted leading-snug">{finding.fix}</span>}
            {canAdjustLimits && finding.endpoint && (
                <Link
                    to={graphStoreLimitsPath(finding.endpoint, search)}
                    className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                    Adjust limits on {finding.endpoint}
                </Link>
            )}
        </li>
    )
}

function ReplicationLine({ shard, canAdjustLimits }: { shard: GraphStoreShard; canAdjustLimits?: boolean }) {
    const r = shard.replication
    const parts: string[] = []
    if (r.replicasTotal === 0) {
        parts.push('No replicas attached')
    } else {
        parts.push(`${r.replicasTotal} replica${r.replicasTotal === 1 ? '' : 's'}`)
        parts.push(
            r.replicasOnline === r.replicasTotal
                ? (r.replicasTotal === 1 ? 'online' : 'all online')
                : `${r.replicasOnline} of ${r.replicasTotal} online`,
        )
        parts.push(lagLabel(r.maxLagBytes))
    }
    if (r.fullResyncs) parts.push(`${r.fullResyncs} full resync${r.fullResyncs === 1 ? '' : 's'} since start`)
    return (
        <div className="mt-2">
            <p className="text-[11px] text-ink-muted">{parts.join(' · ')}</p>
            {r.findings.length > 0 && (
                <ul className="mt-1 divide-y divide-glass-border">
                    {r.findings.map(f => (
                        <Finding key={`${f.code}:${f.endpoint ?? ''}`} finding={f} canAdjustLimits={canAdjustLimits} />
                    ))}
                </ul>
            )}
        </div>
    )
}

function GraphRow({ graph, onOpenSource }: {
    graph: GraphOnShard
    onOpenSource?: (dsId: string) => void
}) {
    const size = graph.measuredBytes ?? graph.estimatedBytes
    const ds = graph.dataSources[0]
    return (
        <tr className={cn('border-t border-glass-border', !graph.present && 'opacity-60')}>
            <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-secondary break-all">{graph.key}</td>
            <td className="py-1.5 pr-3 text-[11px] text-ink-muted">
                {ds
                    ? (onOpenSource
                        ? <button
                            type="button"
                            onClick={() => onOpenSource(ds.id)}
                            className="text-ink-secondary hover:text-ink hover:underline text-left"
                        >
                            {ds.label ?? ds.id}
                        </button>
                        : (ds.label ?? ds.id))
                    : <span className="text-amber-600 dark:text-amber-400">no data source claims it</span>}
                {ds?.workspaceName && <span className="text-ink-muted"> · {ds.workspaceName}</span>}
            </td>
            <td className="py-1.5 pr-3 text-[11px] text-ink-muted whitespace-nowrap">{GRAPH_ROLE_LABEL[graph.role] ?? graph.role}</td>
            <td className="py-1.5 pr-3 text-[11px] text-ink-muted tabular-nums text-right">{compactEdges(graph.edgeCount)}</td>
            <td className="py-1.5 pr-3 text-[11px] text-ink-muted tabular-nums text-right whitespace-nowrap">
                {size == null ? '—' : graph.measuredBytes != null ? compactBytes(size) : `~${compactBytes(size)}`}
            </td>
            <td className="py-1.5 text-[11px] text-ink-muted whitespace-nowrap">
                {!graph.present
                    ? <span className="text-amber-600 dark:text-amber-400">not found on the node</span>
                    : (ds?.aggregationStatus ?? '')}
            </td>
        </tr>
    )
}

function GraphsTable({ shard, onOpenSource }: {
    shard: GraphStoreShard
    onOpenSource?: (dsId: string) => void
}) {
    const [query, setQuery] = useState('')
    const [expanded, setExpanded] = useState(false)

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return shard.graphs
        return shard.graphs.filter(g =>
            g.key.toLowerCase().includes(q)
            || g.dataSources.some(d =>
                (d.label ?? '').toLowerCase().includes(q)
                || (d.workspaceName ?? '').toLowerCase().includes(q)
                || d.id.toLowerCase().includes(q)),
        )
    }, [shard.graphs, query])

    if (shard.graphs.length === 0) {
        return (
            <p className="mt-2 text-[11px] text-ink-muted">
                {shard.inventoryRead === false
                    ? 'This node could not say what it holds yet, and the catalogue expects nothing here.'
                    : 'No graphs on this shard yet.'}
            </p>
        )
    }
    // The collapse bounds the DOM; the search must not un-bound it. On a
    // shard at the row cap, one keystroke would otherwise mount two
    // thousand rows — and again on the next keystroke.
    const shown = expanded ? filtered : filtered.slice(0, GRAPHS_COLLAPSED)

    return (
        <div className="mt-2">
            {shard.inventoryRead === false && (
                <p
                    data-testid={`inventory-unread-${shard.index}`}
                    className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
                >
                    This node has not said which graphs it holds — the list below is what the
                    catalogue expects, not what was found. Nothing here means a graph is missing.
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <label className="relative flex-1 min-w-[12rem]">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted" aria-hidden="true" />
                    <input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={`Search ${shard.graphsTotal.toLocaleString()} graph${shard.graphsTotal === 1 ? '' : 's'} on this shard`}
                        aria-label={`Search the graphs on shard ${shard.index + 1}`}
                        className="w-full h-7 pl-7 pr-2 rounded-lg border border-glass-border bg-transparent text-[11px] text-ink placeholder:text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                    />
                </label>
                {shard.unregisteredCount > 0 && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        {shard.unregisteredCount} unregistered
                    </span>
                )}
            </div>
            <div className="mt-1.5 overflow-x-auto">
                <table className="w-full text-left">
                    <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-ink-muted">
                            <th scope="col" className="py-1 pr-3 font-medium">Graph</th>
                            <th scope="col" className="py-1 pr-3 font-medium">Data source</th>
                            <th scope="col" className="py-1 pr-3 font-medium">Role</th>
                            <th scope="col" className="py-1 pr-3 font-medium text-right">Edges</th>
                            <th scope="col" className="py-1 pr-3 font-medium text-right">Size</th>
                            <th scope="col" className="py-1 font-medium">State</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map(g => <GraphRow key={g.key} graph={g} onOpenSource={onOpenSource} />)}
                    </tbody>
                </table>
            </div>
            {filtered.length > GRAPHS_COLLAPSED && (
                <button
                    type="button"
                    onClick={() => setExpanded(v => !v)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-ink"
                >
                    {expanded
                        ? <><ChevronDown className="w-3 h-3" /> Show fewer</>
                        : <><ChevronRight className="w-3 h-3" /> Show all {filtered.length.toLocaleString()}{query ? ' matches' : ''}</>}
                </button>
            )}
            {query && filtered.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-muted">Nothing on this shard matches “{query}”.</p>
            )}
            {shard.graphsTruncated && (
                <p className="mt-1 text-[10px] text-ink-muted">
                    The largest {shard.graphs.length.toLocaleString()} of {shard.graphsTotal.toLocaleString()} graphs are listed.
                </p>
            )}
        </div>
    )
}

export function ShardCard({ shard, instanceId, reservePct, canAdjustLimits, focused, onOpenSource }: {
    shard: GraphStoreShard
    instanceId: string
    reservePct?: number | null
    canAdjustLimits?: boolean
    focused?: boolean
    onOpenSource?: (dsId: string) => void
}) {
    const slots = slotRangeLabel(shard)
    const capacity = shard.capacity
    // Opening a node's limits from here must keep the view and the focused
    // shard the operator navigated to; closing the dialog only clears
    // ``limits``, so whatever the link dropped is gone for good.
    const { search } = useLocation()
    // "Open in Graph store" on a data source names one shard of what can be
    // sixteen. A ring on a card the operator never scrolls to reads as a
    // link that did nothing.
    const card = useRef<HTMLElement | null>(null)
    useEffect(() => {
        if (!focused) return
        card.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    }, [focused])
    return (
        <section
            ref={card}
            id={`shard-${instanceId}:${shard.index}`}
            data-testid={`shard-card-${shard.index}`}
            className={cn(
                'rounded-xl border bg-canvas-elevated px-3.5 py-3',
                focused ? 'border-indigo-500/60 ring-2 ring-indigo-500/30' : 'border-glass-border',
            )}
        >
            <div className="flex flex-wrap items-baseline gap-x-2">
                <h4 className="text-[12px] font-semibold text-ink">Shard {shard.index + 1}</h4>
                {slots && (
                    <HoverTip label={`Slots ${slots}`} detail="A graph key hashes to one of 16,384 slots; this shard owns these, so every key that hashes into the range lives here.">
                        <span className="text-[11px] text-ink-muted tabular-nums">slots {slots}</span>
                    </HoverTip>
                )}
                <span className="text-[11px] text-ink-muted">
                    · {shard.graphsTotal.toLocaleString()} graph{shard.graphsTotal === 1 ? '' : 's'}
                </span>
            </div>

            <NodeRow
                node={shard.master}
                reservePct={reservePct}
                fitsEdges={capacity?.allowedGrowthEdges ?? null}
                heldNote={capacity ? heldByRebuilds(capacity) : null}
                canAdjustLimits={canAdjustLimits}
                limitsHref={graphStoreLimitsPath(shard.master.endpoint, search)}
            />
            {shard.replicas.map(r => (
                <NodeRow key={r.endpoint} node={r} reservePct={reservePct} />
            ))}

            <ReplicationLine shard={shard} canAdjustLimits={canAdjustLimits} />
            <GraphsTable shard={shard} onOpenSource={onOpenSource} />
        </section>
    )
}
