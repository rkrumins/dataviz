/**
 * EdgeResultsList — a Connections search's answer: every edge it matched,
 * source → type → target, in the engine's order (source name, target name,
 * type), with the exact count of each edge type.
 *
 *   NARROW TO  [Transforms 120] [Produces 7]
 *   ◆ amount  in raw_orders  ─ Transforms → ◆ amount_usd  in clean_orders   ⌖ ⧉
 *
 * A type chip narrows Through to that type. A row shows both its ends on
 * the canvas, opens either, or copies the edge's id; the match bar's
 * stepper (J / K) walks the rows.
 */
import { ArrowRight, Check, Copy, Crosshair } from 'lucide-react'
import { type FC, type ReactNode, type RefObject, useEffect, useMemo, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEdgeVisual, useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import { useFocusedEdgeKey, useIsFocusedEdge } from '@/store/searchStore'
import type { AncestorRef, EdgeEnd, EdgeHit, EdgesPredicate, Predicate } from '@/types/search'

import { connectionSetOf, useEndCounts, withConnectionSet } from './ConnectionBuilder'
import { VirtualizedHitList } from './VirtualizedHitList'
import { edgeTypeName } from './vocabulary/edgeWords'


/** Stable DOM-id prefix for edge rows, for the stepper to scroll to. */
export const EDGE_ROW_ID_PREFIX = 'search-edge-row-'

/** Past this many rows, only the ones in view are mounted. */
const VIRTUALIZE_FROM = 200
const ROW_ESTIMATE_PX = 52

/** Reveal one entity on the canvas, walking down its containers. */
type Reveal = (urn: string, ancestorPath: AncestorRef[]) => void | Promise<unknown>


/** Both ends of an edge on the canvas: the target, then the source, so the
 *  view comes to rest where the connection starts. */
export async function revealEdge(edge: EdgeHit, reveal: Reveal): Promise<void> {
    await reveal(edge.target.urn, edge.target.ancestorPath ?? [])
    await reveal(edge.source.urn, edge.source.ancestorPath ?? [])
}


export interface EdgeResultsListProps {
    edges: EdgeHit[]
    /** Exact, per edge type, over every match — not only the rows listed. */
    typeCounts: Record<string, number>
    /** The draft, when it is a Connections search: what a type chip narrows. */
    draft?: EdgesPredicate | null
    onRefine?: (next: Predicate) => void
    onReveal?: Reveal
    onOpen?: (urn: string) => void
    scrollElementRef: RefObject<HTMLElement | null>
    /** Under the rows: the next page, when there is one. */
    footer?: ReactNode
}


export const EdgeResultsList: FC<EdgeResultsListProps> = ({
    edges, typeCounts, draft, onRefine, onReveal, onOpen, scrollElementRef, footer,
}) => {
    // The stepper moved: bring its row into view, as the entity rows do.
    const focused = useFocusedEdgeKey()
    useEffect(() => {
        if (!focused) return
        document.getElementById(`${EDGE_ROW_ID_PREFIX}${focused}`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, [focused])

    const types = useMemo(() => Object.entries(typeCounts).sort((a, b) => b[1] - a[1]), [typeCounts])
    const row = (edge: EdgeHit) => <EdgeRow key={edge.key} edge={edge} onReveal={onReveal} onOpen={onOpen} />

    return (
        <section className="flex flex-col gap-1.5 p-2 pt-1">
            {types.length >= 2 && draft && onRefine && (
                <TypeChips types={types} draft={draft} onRefine={onRefine} />
            )}
            <div className="mt-0.5">
                {edges.length > VIRTUALIZE_FROM ? (
                    <VirtualizedHitList rows={edges} scrollElementRef={scrollElementRef}
                                        estimateRowSize={() => ROW_ESTIMATE_PX}
                                        renderRow={(i) => row(edges[i])} />
                ) : edges.map(row)}
            </div>
            {footer}
        </section>
    )
}


/** The edge types the matches come in, each with its exact count: one
 *  narrows Through to it; again, and it's every link once more. */
function TypeChips({ types, draft, onRefine }: {
    types: ReadonlyArray<[string, number]>
    draft: EdgesPredicate
    onRefine: (next: Predicate) => void
}) {
    const only = draft.edgeTypes?.length === 1 ? draft.edgeTypes[0].toUpperCase() : null
    return (
        <div role="group" aria-label="Narrow by edge type" className="mx-1 mt-1 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-2xs uppercase tracking-wider text-ink-muted">Narrow to</span>
            {types.map(([type, count]) => {
                const active = only === type.toUpperCase()
                return (
                    <TypeChip key={type} type={type} count={count} active={active}
                              onClick={() => onRefine(active ? withConnectionSet(draft, 'links')
                                  : { ...withConnectionSet(draft, 'types'), edgeTypes: [type] })} />
                )
            })}
        </div>
    )
}


function TypeChip({ type, count, active, onClick }: {
    type: string
    count: number
    active: boolean
    onClick: () => void
}) {
    const color = useEdgeVisual(type).strokeColor
    const name = edgeTypeName(type)
    return (
        <button type="button" onClick={onClick} aria-pressed={active}
                aria-label={`${active ? 'Every link again, not only' : 'Only'} ${name}: ${count.toLocaleString()}`}
                className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                style={{ color, borderColor: `${color}${active ? '99' : '33'}`,
                    backgroundColor: `${color}${active ? '26' : '12'}` }}>
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
            <span className="max-w-[9rem] truncate">{name}</span>
            <span className="text-2xs tabular-nums opacity-80">{count.toLocaleString()}</span>
        </button>
    )
}


/** One edge: its source, its type, its target — each end opens on a click,
 *  and the row shows both ends on the canvas or copies the edge's id. */
function EdgeRow({ edge, onReveal, onOpen }: {
    edge: EdgeHit
    onReveal?: Reveal
    onOpen?: (urn: string) => void
}) {
    const isFocused = useIsFocusedEdge(edge.key)
    return (
        <div id={`${EDGE_ROW_ID_PREFIX}${edge.key}`}
             className={cn(
                 'group flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5',
                 'hover:border-glass-border hover:bg-glass/40 transition-colors duration-150',
                 isFocused && 'ring-2 ring-inset ring-accent-lineage/60 bg-accent-lineage/10',
             )}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <End end={edge.source} onOpen={onOpen} />
                <TypePill edge={edge} />
                <End end={edge.target} onOpen={onOpen} />
            </div>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {onReveal && (
                    <HoverTip label="Show both ends on the canvas">
                        <button type="button" onClick={() => void revealEdge(edge, onReveal)}
                                aria-label={`Show ${edge.source.displayName} and ${edge.target.displayName} on the canvas`}
                                className="rounded-md p-1 text-ink-muted hover:bg-cyan-500/10 hover:text-cyan-600 dark:hover:text-cyan-400">
                            <Crosshair className="h-3.5 w-3.5" />
                        </button>
                    </HoverTip>
                )}
                <CopyId id={edge.id} />
            </div>
        </div>
    )
}


/** An end: the type's icon, its name (opens it), and the container it sits in. */
function End({ end, onOpen }: { end: EdgeEnd; onOpen?: (urn: string) => void }) {
    const visual = useEntityVisual(end.entityType)
    const name = end.displayName || end.urn
    return (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
            <DynamicIcon name={visual.icon} className="h-3.5 w-3.5 shrink-0" style={{ color: visual.color }} />
            {onOpen ? (
                <button type="button" onClick={() => onOpen(end.urn)} title={`Open ${name}`}
                        className="min-w-0 truncate text-[12px] font-medium text-ink hover:text-accent-lineage hover:underline">
                    {name}
                </button>
            ) : <span className="min-w-0 truncate text-[12px] font-medium text-ink">{name}</span>}
            {end.parent && (
                <span className="min-w-0 truncate text-[11px] text-ink-muted" title={end.parent.urn}>
                    in {end.parent.displayName}
                </span>
            )}
        </span>
    )
}


/** The edge's type, pointing from source to target; its properties on hover. */
function TypePill({ edge }: { edge: EdgeHit }) {
    const color = useEdgeVisual(edge.edgeType).strokeColor
    const properties = Object.entries(edge.properties ?? {})
    const pill = (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-medium leading-5"
              style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}>
            {edgeTypeName(edge.edgeType)}
            <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
    )
    if (properties.length === 0) return pill
    return (
        <HoverTip label={`${edgeTypeName(edge.edgeType)} edge`} detail={(
            <span className="flex flex-col gap-0.5 font-mono text-[10.5px]">
                {properties.slice(0, 12).map(([k, v]) => (
                    <span key={k} className="truncate">{k}: {typeof v === 'string' ? v : JSON.stringify(v)}</span>
                ))}
                {properties.length > 12 && <span>+{properties.length - 12} more</span>}
            </span>
        )}>
            {pill}
        </HoverTip>
    )
}


function CopyId({ id }: { id: string }) {
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied) return
        const t = setTimeout(() => setCopied(false), 1200)
        return () => clearTimeout(t)
    }, [copied])
    return (
        <HoverTip label={copied ? 'Copied' : 'Copy the edge’s id'} detail={id}>
            <button type="button" aria-label="Copy the edge’s id"
                    onClick={() => { void navigator.clipboard?.writeText(id).then(() => setCopied(true)) }}
                    className="rounded-md p-1 text-ink-muted hover:bg-glass/60 hover:text-ink">
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
        </HoverTip>
    )
}


/** A Connections search that found nothing: how many entities meet each
 *  end — "nothing meets From" asks for a different fix from "they never
 *  link" — and the changes most likely to find some. */
export function NoConnections({ query, viewId, onRefine }: {
    /** The search that ran. */
    query: EdgesPredicate
    viewId: string
    onRefine?: (next: Predicate) => void
}) {
    const counts = useEndCounts(viewId, query)
    const set = connectionSetOf(query)
    const emptyEnd = counts.sourceWhere.count === 0 ? 'From' : counts.targetWhere.count === 0 ? 'To' : null
    const fixes: { label: string; next: EdgesPredicate }[] = []
    if (query.direction !== 'either') {
        fixes.push({ label: 'Either way — the edges may be stored the other way round',
            next: { ...query, direction: 'either' } })
    }
    if (set !== 'links' && set !== 'any') fixes.push({ label: 'Through any link', next: withConnectionSet(query, 'links') })
    if (query.edgePredicate) {
        const { edgePredicate: _e, ...rest } = query
        fixes.push({ label: 'Without the edge condition', next: rest })
    }
    const end = (where: Predicate | null | undefined, count: { text: string }) =>
        (where ? count.text || 'some entities' : 'any entity')
    return (
        <div className="flex flex-col gap-2.5 rounded-xl border border-glass-border bg-canvas-base/40 p-4">
            <div className="text-sm font-display font-semibold text-ink">No connections</div>
            <p className="text-[12px] leading-relaxed text-ink-muted">
                {emptyEnd
                    ? `Nothing meets ${emptyEnd}, so no edge can ${emptyEnd === 'From' ? 'start' : 'end'} there — loosen its conditions.`
                    : 'No edge joins what From and To find, through the edges asked for.'}
            </p>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-[11.5px]">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">From</dt>
                <dd className="text-ink">{end(query.sourceWhere, counts.sourceWhere)}</dd>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">To</dt>
                <dd className="text-ink">{end(query.targetWhere, counts.targetWhere)}</dd>
            </dl>
            {!emptyEnd && onRefine && fixes.length > 0 && (
                <div className="flex flex-col items-start gap-1">
                    <span className="text-2xs uppercase tracking-wider text-ink-muted">Try</span>
                    {fixes.map((f) => (
                        <button key={f.label} type="button" onClick={() => onRefine(f.next)}
                                className="rounded-md text-left text-[12px] font-medium text-accent-lineage hover:underline">
                            {f.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
