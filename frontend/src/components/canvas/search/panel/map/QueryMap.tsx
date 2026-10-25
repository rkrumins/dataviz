/**
 * QueryMap — the query's shape, drawn above its sentence: what it finds,
 * the relatives its relationships reach and how many of each there are.
 * Every node and edge is a button that opens its part of the sentence.
 *
 * HTML nodes over one SVG edge layer sharing a pixel grid (the User
 * Guide's lineage demo draws the same way), scaled down as a whole when
 * the panel is narrower than the shape.
 */
import { ChevronDown, CircleDashed, MapPin } from 'lucide-react'
import { useId, useState } from 'react'

import { useChartWidth } from '@/components/analytics/charts/chartTheme'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'

import type { ClauseCounts } from '../counts/useClauseCounts'
import type { CountState } from '../counts/useCounts'
import { TypeIcon } from '../sentence/editors'
import { useTypeName } from '../sentence/useTypeName'

import { MAP_GAP_X, MAP_NODE_H, MAP_NODE_W, type MapEdge, type MapNode, type QueryMapLayout } from './layoutQueryMap'


const OPEN_KEY = 'synodic.advancedSearch.queryMap'

function readOpen(): boolean {
    try { return localStorage.getItem(OPEN_KEY) !== 'closed' } catch { return true }
}

const TONE: Record<MapEdge['tone'], string> = {
    accent: 'text-accent-lineage',
    muted: 'text-ink-muted/60',
    rose: 'text-rose-500 dark:text-rose-400',
}


export function QueryMap({ map, counts, onOpen }: {
    map: QueryMapLayout
    counts: ClauseCounts
    /** Open a token of the sentence. */
    onOpen: (token: string) => void
}) {
    const [open, setOpen] = useState(readOpen)
    const [ref, width] = useChartWidth()
    const ids = useId()
    const scale = Math.min(1, width / map.width)
    const toggle = () => {
        setOpen(!open)
        try { localStorage.setItem(OPEN_KEY, open ? 'closed' : 'open') } catch { /* not remembered */ }
    }
    const countOf = (node: MapNode): CountState | null => !node.count ? null
        : node.count.of === 'total' ? counts.total : counts.clauses[node.count.clause]?.where ?? null

    return (
        <div ref={ref} role="figure" aria-label="The query's shape" className="flex flex-col gap-2">
            <button type="button" onClick={toggle} aria-expanded={open}
                    className="inline-flex items-center gap-1 self-start rounded-md px-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} aria-hidden />
                Map
            </button>
            {open && (
                <div className="w-full" style={{ height: map.height * scale }}>
                    <div className="relative mx-auto origin-top-left"
                         style={{ width: map.width, height: map.height, transform: `scale(${scale})` }}>
                        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={map.width}
                             height={map.height} aria-hidden>
                            <defs>
                                {(Object.keys(TONE) as Array<MapEdge['tone']>).map((tone) => (
                                    <marker key={tone} id={`${ids}-${tone}`} viewBox="0 0 10 10" refX="8" refY="5"
                                            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                        <path d="M0 0 L10 5 L0 10 z" fill="currentColor" className={TONE[tone]} />
                                    </marker>
                                ))}
                            </defs>
                            {map.edges.map((e) => (
                                <path key={e.id} d={e.d} fill="none" stroke="currentColor" strokeLinecap="round"
                                      strokeWidth={e.tone === 'muted' ? 1.25 : 1.75}
                                      strokeDasharray={e.dashed ? '5 4' : undefined}
                                      markerEnd={e.arrow === 'end' || e.arrow === 'both' ? `url(#${ids}-${e.tone})` : undefined}
                                      markerStart={e.arrow === 'start' || e.arrow === 'both' ? `url(#${ids}-${e.tone})` : undefined}
                                      className={TONE[e.tone]} />
                            ))}
                        </svg>
                        {map.edges.map((e) => (e.label || e.reach) && (
                            <EdgeLabel key={e.id} edge={e} onOpen={onOpen} />
                        ))}
                        {map.nodes.map((n) => (
                            <MapNodeButton key={n.id} node={n} count={countOf(n)} onOpen={onOpen} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}


function EdgeLabel({ edge, onOpen }: { edge: MapEdge; onOpen: (token: string) => void }) {
    return (
        <button type="button" onClick={() => onOpen(edge.token)}
                aria-label={`Change how they relate: ${[edge.label, edge.reach].filter(Boolean).join(', ')}`}
                className={cn(
                    'absolute flex flex-col rounded-md px-1 text-2xs leading-tight transition-colors',
                    'bg-canvas-elevated/90 hover:bg-accent-lineage/10',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    edge.vertical ? 'items-start text-left' : 'items-center text-center',
                    edge.tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : 'text-ink',
                )}
                style={edge.vertical
                    ? { left: edge.labelAt.x + 6, top: edge.labelAt.y, transform: 'translateY(-50%)', maxWidth: MAP_NODE_W / 2 + 20 }
                    : { left: edge.labelAt.x, top: edge.labelAt.y, transform: 'translate(-50%, -50%)', maxWidth: MAP_GAP_X - 4 }}>
            {edge.label && <span className="font-medium">{edge.label}</span>}
            {edge.reach && <span className="text-ink-muted tabular-nums">{edge.reach}</span>}
        </button>
    )
}


function MapNodeButton({ node, count, onOpen }: {
    node: MapNode
    count: CountState | null
    onOpen: (token: string) => void
}) {
    const typeName = useTypeName()
    const visual = useEntityVisual(node.types[0] ?? '')
    const typed = node.types.length > 0
    const label = node.kind === 'named' ? node.names.join(', ') || 'pick…'
        : typed ? node.types.map((t) => typeName(t, node.kind === 'subject' || node.several)).join(' or ')
            : 'Anything'
    const chips = node.chips.length > 1 && node.chipsJoin === 'or'
        ? `any of: ${node.chips.join(' · ')}` : node.chips.join(' · ')
    const zero = count?.complete && count.count === 0
    const countText = count ? `${count.count.toLocaleString()}${count.complete ? '' : '+'}` : null
    const what = node.kind === 'subject' ? 'Change what the query finds'
        : node.kind === 'named' ? 'Change which entities' : 'Change which relatives'

    return (
        <div className="absolute" style={{ left: node.x, top: node.y }}>
            <HoverTip label={[label, chips].filter(Boolean).join(' — ')} detail={what}>
                <button type="button" onClick={() => onOpen(node.token)}
                        aria-label={`${what}: ${label}${chips ? `, ${chips}` : ''}${countText ? `, ${countText}` : ''}`}
                        className={cn(
                            'flex flex-col justify-center gap-0.5 rounded-xl border border-glass-border px-2.5 text-left',
                            'bg-canvas-elevated shadow-sm transition-[transform,box-shadow] duration-200',
                            'hover:-translate-y-0.5 hover:shadow-md',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50',
                            node.kind === 'subject' && 'ring-1 ring-accent-lineage/30',
                            !typed && node.kind !== 'named' && 'border-dashed',
                        )}
                        style={{
                            width: MAP_NODE_W, height: MAP_NODE_H, borderLeftWidth: 3,
                            borderLeftColor: typed ? visual.color : undefined,
                        }}>
                    <span className="flex min-w-0 items-center gap-1.5">
                        {node.kind === 'named' ? <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                            : typed ? <TypeIcon type={node.types[0]} />
                                : <CircleDashed className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />}
                        <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold',
                            typed || node.kind === 'named' ? 'text-ink' : 'text-ink-muted')}>{label}</span>
                        {countText && (
                            <span className={cn('shrink-0 text-xs font-medium tabular-nums',
                                zero ? 'text-rose-500 dark:text-rose-400' : 'text-ink-muted')}>{countText}</span>
                        )}
                    </span>
                    {(chips || node.kind === 'subject') && (
                        <span className="truncate text-2xs text-ink-muted">{chips || 'what the query finds'}</span>
                    )}
                </button>
            </HoverTip>
        </div>
    )
}
