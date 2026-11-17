/**
 * CopyRoomBar — whether a graph can be copied: the free memory a copy needs (the graph's size
 * times the copy room) laid over each node's room for it, on one scale so the nodes compare.
 *
 * A copy must fit under the node's start mark (where unloading starts), so a node's room is what
 * is free below that mark, not all its free memory. Where the copy doesn't fit, the bracket runs
 * past the room into the shortfall. A staged copy room draws its own bracket in the accent.
 */
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatNumber } from '@/lib/units'
import type { NodeMemory } from '../types'
import { LegendKey, VisualFrame } from './VisualFrame'

function Bracket({ from, bytes, scale, className }: { from: number; bytes: number; scale: number; className: string }) {
    const left = (from / scale) * 100
    const want = (bytes / scale) * 100
    const open = want > 100 - left
    return (
        <div className="relative mt-1 h-2">
            <span className={cn('absolute inset-y-0 rounded-sm border-b-2 border-l-2', !open && 'border-r-2', className)}
                style={{ left: `${left}%`, width: `${Math.min(want, 100 - left)}%` }} />
        </div>
    )
}

export function CopyRoomBar({ graph, copyRoomPct, nextCopyRoomPct, startPct, copyMaxBytes, nodes, className }: {
    /** The graph to copy: the largest, usually. */
    graph: { name: string; bytes: number }
    /** Percent of the graph's size. */
    copyRoomPct: number
    nextCopyRoomPct?: number
    /** The start mark (percent of a node's memory): a copy must fit under it. */
    startPct: number
    copyMaxBytes?: number | 'unlimited'
    nodes: NodeMemory[]
    className?: string
}) {
    const need = (graph.bytes * copyRoomPct) / 100
    const changed = nextCopyRoomPct !== undefined && nextCopyRoomPct !== copyRoomPct
    const needNext = changed ? (graph.bytes * (nextCopyRoomPct as number)) / 100 : null
    const scale = Math.max(...nodes.map((n) => n.maxBytes), 1)
    const w = (bytes: number) => `${(bytes / scale) * 100}%`
    const room = (n: NodeMemory) => Math.max(0, (n.maxBytes * startPct) / 100 - n.usedBytes)
    const fits = nodes.filter((n) => room(n) >= need).length
    const fitsNext = needNext !== null ? nodes.filter((n) => room(n) >= needNext).length : null
    const tooBig = typeof copyMaxBytes === 'number' && graph.bytes > copyMaxBytes

    return (
        <VisualFrame
            title="Room for a copy"
            className={className}
            legend={(
                <>
                    <LegendKey className="bg-slate-400/70 dark:bg-slate-500">In use</LegendKey>
                    <LegendKey className="bg-emerald-500/25">Room under the start mark</LegendKey>
                    <LegendKey kind="line" className="border-ink-secondary">A copy needs</LegendKey>
                    {changed && <LegendKey kind="line" className="border-accent-lineage">With your change</LegendKey>}
                </>
            )}
            caption={(
                <>
                    {graph.name} is {formatBytes(graph.bytes)}. At {formatNumber(copyRoomPct)}%, a copy needs {formatBytes(need)} free under a node’s start mark ({formatNumber(startPct)}%): it fits on {fits} of {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}.
                    {needNext !== null && fitsNext !== null && (
                        <>{' '}<span className="font-medium text-indigo-700 dark:text-indigo-300">With your change ({formatNumber(nextCopyRoomPct as number)}%) it needs {formatBytes(needNext)}: it fits on {fitsNext}.</span></>
                    )}
                    {tooBig && typeof copyMaxBytes === 'number' && ` It is larger than the largest graph copied (${formatBytes(copyMaxBytes)}), so it is built from the database instead.`}
                </>
            )}
        >
            <ul className="space-y-4">
                {nodes.map((n) => {
                    const free = room(n)
                    const ok = free >= need
                    const mark = (n.maxBytes * startPct) / 100
                    return (
                        <li key={n.id}>
                            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-[11.5px]">
                                <span className="font-semibold text-ink">{n.label}</span>
                                <span className="inline-flex items-center gap-1 tabular-nums text-ink-secondary">
                                    {formatBytes(free)} of room ·
                                    {ok ? (
                                        <span className="inline-flex items-center gap-0.5 font-medium text-emerald-700 dark:text-emerald-400"><Check aria-hidden className="w-3 h-3" /> A copy fits</span>
                                    ) : (
                                        <span className="inline-flex items-center gap-0.5 font-medium text-rose-700 dark:text-rose-400"><X aria-hidden className="w-3 h-3" /> {formatBytes(need - free)} short</span>
                                    )}
                                </span>
                            </div>
                            <div className="relative" aria-hidden>
                                <div className="relative h-3 rounded-full bg-black/[0.04] dark:bg-white/[0.05]" style={{ width: w(n.maxBytes) }}>
                                    <div className="absolute inset-y-0 left-0 rounded-l-full bg-slate-400/70 dark:bg-slate-500" style={{ width: `${Math.min(100, (n.usedBytes / n.maxBytes) * 100)}%` }} />
                                    {free > 0 && (
                                        <div className="absolute inset-y-0 bg-emerald-500/25"
                                            style={{ left: `calc(${(n.usedBytes / n.maxBytes) * 100}% + 2px)`, width: `calc(${(free / n.maxBytes) * 100}% - 2px)` }} />
                                    )}
                                    <span className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink-secondary/70" style={{ left: `${startPct}%` }} />
                                </div>
                                <Bracket from={Math.min(n.usedBytes, mark)} bytes={need} scale={scale} className={ok ? 'border-ink-secondary/70' : 'border-rose-500/80'} />
                                {needNext !== null && <Bracket from={Math.min(n.usedBytes, mark)} bytes={needNext} scale={scale} className="border-accent-lineage" />}
                            </div>
                            <span className="sr-only">
                                {n.label}: {formatBytes(n.usedBytes)} of {formatBytes(n.maxBytes)} in use, {formatBytes(free)} free under the start mark; {ok ? 'a copy fits' : `${formatBytes(need - free)} short of the ${formatBytes(need)} a copy needs`}.
                            </span>
                        </li>
                    )
                })}
            </ul>
        </VisualFrame>
    )
}
