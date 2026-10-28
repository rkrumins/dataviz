/**
 * EdgeResultsTable — a Connections search's edges as a table, for the room
 * Search Studio has: one row an edge, in the server's order, more loaded as
 * the end comes into view. Its edge properties can be added as columns;
 * rows can be picked and framed on the canvas, or copied as CSV.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { Copy, Crosshair, Focus } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEdgeVisual, useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import type { AncestorRef, EdgeEnd, EdgeHit } from '@/types/search'

import { revealEdge } from '../panel/EdgeResultsList'
import { edgeTypeName } from '../panel/vocabulary/edgeWords'


const ROW_PX = 36


export interface EdgeResultsTableProps {
    edges: readonly EdgeHit[]
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void | Promise<unknown>
    onOpen?: (urn: string) => void
    onFrame?: (urns: string[]) => void
    canLoadMore: boolean
    isLoadingMore: boolean
    onLoadMore?: () => void
}


export function EdgeResultsTable({ edges, onReveal, onOpen, onFrame, canLoadMore, isLoadingMore, onLoadMore }:
    EdgeResultsTableProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    const [shownKeys, setShownKeys] = useState<string[]>([])
    const virtualizer = useVirtualizer({
        count: edges.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_PX, overscan: 12,
    })
    const items = virtualizer.getVirtualItems()
    const last = items[items.length - 1]?.index ?? -1

    // More rows as the end comes into view.
    useEffect(() => {
        if (canLoadMore && !isLoadingMore && last >= edges.length - 8) onLoadMore?.()
    }, [last, edges.length, canLoadMore, isLoadingMore, onLoadMore])

    // Rows that are no longer there can't stay picked.
    useEffect(() => {
        setPicked((prev) => {
            const here = new Set(edges.map((e) => e.key))
            const next = new Set([...prev].filter((k) => here.has(k)))
            return next.size === prev.size ? prev : next
        })
    }, [edges])

    // The edge properties the loaded edges carry, most common first.
    const keys = useMemo(() => {
        const seen = new Map<string, number>()
        for (const e of edges) for (const k of Object.keys(e.properties ?? {})) seen.set(k, (seen.get(k) ?? 0) + 1)
        return [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
    }, [edges])
    const columns = `28px minmax(7rem,1.4fr) minmax(5rem,1fr) 6.5rem minmax(7rem,1.4fr) minmax(5rem,1fr)${
        shownKeys.map(() => ' minmax(4.5rem,0.8fr)').join('')} 2rem`

    const toggle = (key: string) => setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
    const allPicked = edges.length > 0 && picked.size === edges.length
    const pickedEdges = useMemo(() => edges.filter((e) => picked.has(e.key)), [edges, picked])

    return (
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-glass-border bg-canvas-elevated/40">
            {keys.length > 0 && (
                <div role="group" aria-label="Edge properties as columns"
                     className="flex flex-wrap items-center gap-1 border-b border-glass-border px-2 py-1.5">
                    <span className="mr-0.5 text-2xs uppercase tracking-wider text-ink-muted">Edge properties</span>
                    {keys.slice(0, 12).map((k) => {
                        const on = shownKeys.includes(k)
                        return (
                            <button key={k} type="button" aria-pressed={on}
                                    onClick={() => setShownKeys((s) => (on ? s.filter((x) => x !== k) : [...s, k]))}
                                    className={cn('rounded-md px-1.5 py-0.5 font-mono text-2xs transition-colors',
                                        on ? 'bg-accent-lineage/15 text-accent-lineage'
                                            : 'border border-dashed border-glass-border text-ink-muted hover:text-ink')}>
                                {k}
                            </button>
                        )
                    })}
                </div>
            )}
            <div role="row" style={{ gridTemplateColumns: columns }}
                 className="grid items-center gap-2 border-b border-glass-border px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                <input type="checkbox" aria-label="Pick every loaded row" checked={allPicked}
                       onChange={() => setPicked(allPicked ? new Set() : new Set(edges.map((e) => e.key)))}
                       className="h-3.5 w-3.5 accent-accent-lineage" />
                <span>Source</span><span>Source parent</span><span>Type</span><span>Target</span><span>Target parent</span>
                {shownKeys.map((k) => <span key={k} className="truncate normal-case font-mono">{k}</span>)}
                <span />
            </div>

            {picked.size > 0 && (
                <div role="toolbar" aria-label="Act on the picked rows"
                     className="flex flex-wrap items-center gap-1.5 border-b border-glass-border bg-accent-lineage/[0.06] px-2 py-1.5 text-xs">
                    <span className="font-medium text-ink">{picked.size.toLocaleString()} picked</span>
                    {onFrame && (
                        <BulkButton icon={Focus} label="Frame on canvas"
                                    onClick={() => onFrame([...new Set(pickedEdges.flatMap((e) => [e.source.urn, e.target.urn]))])} />
                    )}
                    <BulkButton icon={Copy} label="Copy as CSV"
                                onClick={() => void navigator.clipboard?.writeText(toCsv(pickedEdges, shownKeys))} />
                    <button type="button" onClick={() => setPicked(new Set())}
                            className="ml-auto text-ink-muted hover:text-ink">Clear</button>
                </div>
            )}

            <div ref={scrollRef} role="rowgroup" aria-label="Connections" className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((v) => {
                        const edge = edges[v.index]
                        return (
                            <div key={edge.key} className="absolute left-0 top-0 w-full"
                                 style={{ transform: `translateY(${v.start}px)`, height: ROW_PX }}>
                                <Row edge={edge} columns={columns} keys={shownKeys} picked={picked.has(edge.key)}
                                     onToggle={toggle} onReveal={onReveal} onOpen={onOpen} />
                            </div>
                        )
                    })}
                </div>
                {isLoadingMore && <p className="px-3 py-2 text-xs text-ink-muted">Loading more…</p>}
            </div>
        </div>
    )
}


function BulkButton({ icon: Icon, label, onClick }: { icon: typeof Copy; label: string; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick}
                className="inline-flex items-center gap-1 rounded-md border border-black/10 bg-canvas-elevated px-2 py-0.5 text-ink hover:border-accent-lineage/40 dark:border-white/15">
            <Icon className="h-3 w-3" aria-hidden /> {label}
        </button>
    )
}


const Row = memo(function Row({ edge, columns, keys, picked, onToggle, onReveal, onOpen }: {
    edge: EdgeHit
    columns: string
    keys: string[]
    picked: boolean
    onToggle: (key: string) => void
    onReveal?: EdgeResultsTableProps['onReveal']
    onOpen?: (urn: string) => void
}) {
    const color = useEdgeVisual(edge.edgeType).strokeColor
    return (
        <div role="row" aria-selected={picked} style={{ gridTemplateColumns: columns }}
             className={cn('group grid h-full items-center gap-2 border-b border-glass-border/50 px-2 text-sm',
                 picked ? 'bg-accent-lineage/[0.07]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]')}>
            <input type="checkbox" aria-label={`Pick ${edge.source.displayName} to ${edge.target.displayName}`}
                   checked={picked} onChange={() => onToggle(edge.key)} className="h-3.5 w-3.5 accent-accent-lineage" />
            <EndCell end={edge.source} onOpen={onOpen} />
            <ParentCell end={edge.source} />
            <span className="truncate text-xs font-medium" style={{ color }} title={edge.edgeType}>
                {edgeTypeName(edge.edgeType)}
            </span>
            <EndCell end={edge.target} onOpen={onOpen} />
            <ParentCell end={edge.target} />
            {keys.map((k) => {
                const v = edge.properties?.[k]
                const text = v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v)
                return <span key={k} className="truncate font-mono text-xs text-ink-muted" title={text}>{text}</span>
            })}
            <span className="flex items-center justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {onReveal && (
                    <HoverTip label="Show both ends on the canvas" className="inline-flex">
                        <button type="button" aria-label={`Show ${edge.source.displayName} and ${edge.target.displayName} on the canvas`}
                                onClick={() => void revealEdge(edge, onReveal)}
                                className="rounded-md p-1 text-ink-muted hover:bg-accent-lineage/10 hover:text-accent-lineage">
                            <Crosshair className="h-3.5 w-3.5" />
                        </button>
                    </HoverTip>
                )}
            </span>
        </div>
    )
})


function EndCell({ end, onOpen }: { end: EdgeEnd; onOpen?: (urn: string) => void }) {
    const visual = useEntityVisual(end.entityType)
    const name = end.displayName || end.urn
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <DynamicIcon name={visual.icon} className="h-3.5 w-3.5 shrink-0" style={{ color: visual.color }} />
            {onOpen ? (
                <HoverTip label="Open its details" className="flex min-w-0">
                    <button type="button" onClick={() => onOpen(end.urn)}
                            className="truncate font-medium text-ink hover:text-accent-lineage hover:underline">{name}</button>
                </HoverTip>
            ) : <span className="truncate font-medium text-ink" title={name}>{name}</span>}
        </span>
    )
}


function ParentCell({ end }: { end: EdgeEnd }) {
    return (
        <span className="truncate text-xs text-ink-muted"
              title={(end.ancestorPath ?? []).map((a) => a.displayName).join(' / ') || undefined}>
            {end.parent?.displayName ?? '—'}
        </span>
    )
}


/** The rows as CSV, as the export writes its first columns. */
function toCsv(edges: readonly EdgeHit[], keys: string[]): string {
    const cell = (v: unknown) => {
        const text = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const header = ['source', 'sourceParent', 'edgeType', 'target', 'targetParent', ...keys]
    const rows = edges.map((e) => [e.source.displayName, e.source.parent?.displayName, e.edgeType,
        e.target.displayName, e.target.parent?.displayName, ...keys.map((k) => e.properties?.[k])])
    return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}
