/**
 * Render path-search results.
 *
 * Each PathHit is one ordered sequence: source → edge → node → edge → … → target.
 * We render it as a horizontal flow card with entity-type-colored node
 * chips and small edge-type labels on the connecting arrows. Clicking a
 * node chip reveals that node on the canvas (same `onReveal` behaviour
 * as a regular hit row), so users can step through a path by clicking.
 *
 * Sorted by hopCount ascending so the shortest paths surface first.
 */
import { ArrowRight, GitFork, Search } from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import { edgeTypeCopy } from '@/lib/relationshipLabel'
import type { AncestorRef, PathHit } from '@/types/search'


export interface PathResultPanelProps {
    paths: PathHit[]
    truncated?: boolean
    /** Reveal a single node on the canvas. The handler walks its ancestor
     *  chain like a regular search hit. */
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
}


export const PathResultPanel: FC<PathResultPanelProps> = ({
    paths, truncated, onReveal,
}) => {
    // Sort by hopCount ascending; shortest paths are most actionable.
    const sorted = useMemo(
        () => [...paths].sort((a, b) => a.hopCount - b.hopCount),
        [paths],
    )

    if (sorted.length === 0) {
        return (
            <div className="flex flex-col items-center text-center py-10 px-4">
                <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center",
                    "bg-gradient-to-br from-glass/50 to-glass/20 border border-glass-border",
                    "text-ink-muted",
                )}>
                    <Search className="w-6 h-6" strokeWidth={1.75} />
                </div>
                <div className="mt-4 text-sm font-display font-semibold text-ink">
                    No paths between these nodes
                </div>
                <p className="mt-1.5 text-xs text-ink-muted max-w-[22rem] leading-relaxed">
                    Increase the max-hops budget, switch direction, or verify
                    the source and target URNs are connected via the chosen
                    edge class.
                </p>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs text-ink-muted">
                <GitFork className="w-3.5 h-3.5 text-cyan-400" strokeWidth={2} />
                <span>
                    <span className="text-ink font-medium">
                        {sorted.length} {sorted.length === 1 ? 'path' : 'paths'}
                    </span>
                    {' '}found{truncated ? ' (truncated — increase max paths to see more)' : ''}.
                    Shortest first.
                </span>
            </div>

            <div className="flex flex-col gap-2.5">
                {sorted.map((path, i) => (
                    <PathCard
                        key={i}
                        path={path}
                        onReveal={onReveal}
                    />
                ))}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// One path card
// ---------------------------------------------------------------------------

function PathCard({
    path, onReveal,
}: {
    path: PathHit
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
}) {
    return (
        <div className={cn(
            "rounded-xl border border-glass-border/70 bg-canvas-elevated/40",
            "p-3 flex flex-col gap-2",
        )}>
            {/* Header: hop count + edge-type summary */}
            <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                <span className="font-semibold uppercase tracking-[0.14em]">
                    {path.hopCount} {path.hopCount === 1 ? 'hop' : 'hops'}
                </span>
                {path.edges.length > 0 && (
                    <>
                        <span className="text-ink-muted/50">·</span>
                        <span className="font-mono truncate">
                            {uniqueEdgeTypes(path).join(' → ')}
                        </span>
                    </>
                )}
            </div>

            {/* Path flow — node chips connected by arrow + edge-type labels */}
            <div className="flex items-center gap-1 flex-wrap">
                {path.nodes.map((node, i) => (
                    <div key={i} className="flex items-center gap-1">
                        <NodeChip
                            node={node}
                            onClick={onReveal ? () => onReveal(node.urn, []) : undefined}
                        />
                        {i < path.edges.length && (
                            <EdgeArrow edgeType={path.edges[i]?.edgeType ?? ''} />
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}


function NodeChip({
    node, onClick,
}: {
    node: AncestorRef
    onClick?: () => void
}) {
    const colorClass = entityTypeColor(node.entityType)
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            title={node.urn}
            className={cn(
                "inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
                "text-[11px] font-medium",
                "transition-colors",
                colorClass,
                onClick && "hover:brightness-125 cursor-pointer",
                !onClick && "cursor-default",
            )}
        >
            <span className="text-[9px] uppercase tracking-wider opacity-70">
                {node.entityType}
            </span>
            <span className="font-mono">{node.displayName || node.urn}</span>
        </button>
    )
}


function EdgeArrow({ edgeType }: { edgeType: string }) {
    return (
        <div className="flex flex-col items-center px-0.5">
            <span className="text-[8px] font-mono text-ink-muted leading-none">
                {edgeTypeCopy(edgeType)?.label ?? edgeType}
            </span>
            <ArrowRight className="w-3 h-3 text-ink-muted" strokeWidth={2} />
        </div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueEdgeTypes(path: PathHit): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const e of path.edges) {
        if (!seen.has(e.edgeType)) {
            seen.add(e.edgeType)
            out.push(e.edgeType)
        }
    }
    return out
}


/** Visual tint per entity type — small palette matching the rest of the
 *  search panel's color language. Falls back to a neutral chip for
 *  types we don't have a specific accent for. */
function entityTypeColor(entityType: string): string {
    switch (entityType) {
        case 'domain':
            return 'bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30'
        case 'dataPlatform':
            return 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
        case 'container':
            return 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
        case 'dataset':
            return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        case 'schemaField':
            return 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
        default:
            return 'bg-glass/40 text-ink border border-glass-border'
    }
}
