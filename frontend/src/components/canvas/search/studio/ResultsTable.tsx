/**
 * ResultsTable — the matches as a table, for the room Search Studio has:
 * one row each, in the server's order, more loaded as the end comes into
 * view. Rows can be picked and acted on together — framed on the canvas,
 * kept as the only ones, left out, or copied by name.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { Copy, ExternalLink, Filter, Focus, Sparkles, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEntityTypeLabel, useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import type { AncestorRef, Predicate, SearchHit } from '@/types/search'

import { whyItMatched } from '../panel/results/whyItMatched'
import { andWith, buildSentence } from '../panel/sentence/clauseModel'
import { lineText } from '../panel/sentence/lineWords'
import { useTypeName } from '../panel/sentence/useTypeName'
import { matchedFieldLabel } from '../SearchHitRow'


const ROW_PX = 36
/** "Keep only these" names entities one by one — past this, narrow first. */
export const KEEP_MAX = 200
const COLUMNS = 'grid-cols-[28px_minmax(10rem,2fr)_7rem_minmax(9rem,2fr)_minmax(8rem,1.4fr)_4.5rem]'


export interface ResultsTableProps {
    hits: readonly SearchHit[]
    /** The query the rows answer — for what each one met. */
    query: Predicate | null
    draft: Predicate | null
    onRefine: (next: Predicate) => void
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    onLookInside: (ancestor: AncestorRef) => void
    onFrame?: (urns: string[]) => void
    canLoadMore: boolean
    isLoadingMore: boolean
    onLoadMore?: () => void
}


export function ResultsTable({ hits, query, draft, onRefine, onReveal, onOpen, onLookInside, onFrame,
    canLoadMore, isLoadingMore, onLoadMore }: ResultsTableProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    const virtualizer = useVirtualizer({
        count: hits.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_PX, overscan: 12,
    })
    const items = virtualizer.getVirtualItems()
    const last = items[items.length - 1]?.index ?? -1

    // More rows as the end comes into view.
    useEffect(() => {
        if (canLoadMore && !isLoadingMore && last >= hits.length - 8) onLoadMore?.()
    }, [last, hits.length, canLoadMore, isLoadingMore, onLoadMore])

    // Rows that are no longer there can't stay picked.
    useEffect(() => {
        setPicked((prev) => {
            const here = new Set(hits.map((h) => h.node.urn))
            const next = new Set([...prev].filter((u) => here.has(u)))
            return next.size === prev.size ? prev : next
        })
    }, [hits])

    const toggle = (urn: string) => setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(urn)) next.delete(urn)
        else next.add(urn)
        return next
    })
    const allPicked = hits.length > 0 && picked.size === hits.length
    const pickedHits = useMemo(() => hits.filter((h) => picked.has(h.node.urn)), [hits, picked])
    const named = pickedHits.slice(0, KEEP_MAX).map((h) => ({ urn: h.node.urn }))

    return (
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-glass-border bg-canvas-elevated/40">
            <div role="row" className={cn('grid items-center gap-2 border-b border-glass-border px-2 py-1.5',
                'text-2xs font-semibold uppercase tracking-wider text-ink-muted', COLUMNS)}>
                <input type="checkbox" aria-label="Pick every loaded row" checked={allPicked}
                       onChange={() => setPicked(allPicked ? new Set() : new Set(hits.map((h) => h.node.urn)))}
                       className="h-3.5 w-3.5 accent-accent-lineage" />
                <span>Name</span><span>Type</span><span>Where</span><span>Matched because</span><span />
            </div>

            {picked.size > 0 && (
                <div role="toolbar" aria-label="Act on the picked rows"
                     className="flex flex-wrap items-center gap-1.5 border-b border-glass-border bg-accent-lineage/[0.06] px-2 py-1.5 text-xs">
                    <span className="font-medium text-ink">{picked.size.toLocaleString()} picked</span>
                    {onFrame && (
                        <BulkButton icon={Focus} label="Frame on canvas" onClick={() => onFrame([...picked])} />
                    )}
                    <BulkButton icon={Filter} label={picked.size > KEEP_MAX ? `Keep only the first ${KEEP_MAX}` : 'Keep only these'}
                                onClick={() => onRefine(andWith(draft, { kind: 'is', refs: named }))} />
                    <BulkButton icon={X} label="Leave these out"
                                onClick={() => onRefine(andWith(draft, { kind: 'group', op: 'not',
                                    children: [{ kind: 'is', refs: named }] }))} />
                    <BulkButton icon={Copy} label="Copy names"
                                onClick={() => void navigator.clipboard?.writeText(pickedHits.map((h) => h.node.displayName).join('\n'))} />
                    <button type="button" onClick={() => setPicked(new Set())}
                            className="ml-auto text-ink-muted hover:text-ink">Clear</button>
                </div>
            )}

            <div ref={scrollRef} role="rowgroup" aria-label="Matches" className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((v) => {
                        const hit = hits[v.index]
                        return (
                            <div key={hit.node.urn} className="absolute left-0 top-0 w-full"
                                 style={{ transform: `translateY(${v.start}px)`, height: ROW_PX }}>
                                <Row hit={hit} query={query} picked={picked.has(hit.node.urn)} onToggle={toggle}
                                     onReveal={onReveal} onOpen={onOpen} onLookInside={onLookInside} />
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


const Row = memo(function Row({ hit, query, picked, onToggle, onReveal, onOpen, onLookInside }: {
    hit: SearchHit
    query: Predicate | null
    picked: boolean
    onToggle: (urn: string) => void
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    onLookInside: (ancestor: AncestorRef) => void
}) {
    const visual = useEntityVisual(hit.node.entityType)
    const label = useEntityTypeLabel(hit.node.entityType) ?? hit.node.entityType
    const typeName = useTypeName()
    const ancestors = hit.ancestorPath ?? []
    const because = useMemo(() => {
        const met = whyItMatched(query, hit)
        if (met.length && query) {
            const lines = buildSentence(query).lines
            const words = met.flatMap((i) => {
                const line = lines.find((l) => l.topIndex === i)
                const text = line ? lineText(line, typeName) : null
                return text ? [text] : []
            })
            if (words.length) return words.join(' · ')
        }
        const highlight = hit.highlights?.[0]
        return highlight ? `in ${matchedFieldLabel(highlight.field)}` : ''
    }, [query, hit, typeName])

    return (
        <div role="row" aria-selected={picked}
             className={cn('group grid h-full items-center gap-2 border-b border-glass-border/50 px-2 text-sm',
                 picked ? 'bg-accent-lineage/[0.07]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]', COLUMNS)}>
            <input type="checkbox" aria-label={`Pick ${hit.node.displayName}`} checked={picked}
                   onChange={() => onToggle(hit.node.urn)} className="h-3.5 w-3.5 accent-accent-lineage" />
            <span className="flex min-w-0 items-center gap-1.5">
                <DynamicIcon name={visual.icon} className="h-3.5 w-3.5 shrink-0" style={{ color: visual.color }} />
                <span className="truncate font-medium text-ink" title={hit.node.displayName}>{hit.node.displayName}</span>
            </span>
            <span className="truncate text-xs" style={{ color: visual.color }}>{label}</span>
            {/* The nearest two containers say where it is; the whole path is the tip. */}
            <span className="block min-w-0 truncate text-xs text-ink-muted"
                  title={ancestors.map((a) => a.displayName).join(' / ') || undefined}>
                {ancestors.length === 0 ? '—' : (
                    <>
                        {ancestors.length > 2 && <span className="text-ink-muted/50">… / </span>}
                        {ancestors.slice(-2).map((a, i) => (
                            <span key={`${a.urn}-${i}`}>
                                {i > 0 && <span className="text-ink-muted/50"> / </span>}
                                <button type="button" onClick={() => onLookInside(a)} aria-label={`Look inside ${a.displayName}`}
                                        className="hover:text-accent-lineage hover:underline">{a.displayName}</button>
                            </span>
                        ))}
                    </>
                )}
            </span>
            <span className="truncate text-xs text-ink-muted" title={because || undefined}>{because || '—'}</span>
            <span className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {onReveal && (
                    <HoverTip label="Reveal it on the canvas" className="inline-flex">
                        <button type="button" aria-label={`Reveal ${hit.node.displayName} on the canvas`}
                                onClick={() => onReveal(hit.node.urn, ancestors)}
                                className="rounded-md p-1 text-ink-muted hover:bg-accent-lineage/10 hover:text-accent-lineage">
                            <Sparkles className="h-3.5 w-3.5" />
                        </button>
                    </HoverTip>
                )}
                {onOpen && (
                    <HoverTip label="Open its details" className="inline-flex">
                        <button type="button" aria-label={`Open the details of ${hit.node.displayName}`}
                                onClick={() => onOpen(hit.node.urn)}
                                className="rounded-md p-1 text-ink-muted hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.06]">
                            <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                    </HoverTip>
                )}
            </span>
        </div>
    )
})
