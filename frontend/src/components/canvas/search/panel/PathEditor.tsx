/**
 * PathEditor — the body of a path row: every route from where it starts to
 * where it ends, each end named entities or any entity meeting a
 * condition, through edges meeting a filter.
 *
 *   FROM  [Named ▾]  Sales / orders                 1 entity
 *   TO    [Where… ▾] ┌ nested builder ──────────────┐
 *                    │ Entity type is in [dashboard] │
 *                    └───────────────────────────────┘
 *   Downstream ▾   up to [4] hops   at most [32] routes
 *   THROUGH EDGES  confidence ≥ 0.8
 *
 * An end's condition is edited by the same VisualQueryBuilder as the query,
 * one relationship deeper (the server holds it to a relationship's rules).
 * The farther the ends are from named, the fewer hops a route may take.
 */
import { type FC, useContext, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { EdgePredicateNode, NodeRef, PathPredicate, Predicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import { inputClass } from '../typed/fieldStyles'

import { NodeRefList } from './NodeRefPicker'
import { OperatorMenu } from './OperatorMenu'
import type { LayerOption } from './layerOptions'
import { RelationContext, type RelationDiscovery, useEdgeEditorContext } from './relationContext'
import { VisualQueryBuilder } from './VisualQueryBuilder'


/** How far a route may go: the server's caps (`PathPredicate`). */
const HOPS_CAP = [6, 4, 3]
const MAX_PATHS = 128

type Side = 'source' | 'target'

const DIRECTION_OPTIONS: { value: NonNullable<PathPredicate['direction']>; label: string; description: string }[] = [
    { value: 'outgoing', label: 'Downstream', description: 'Each route follows lineage from the start to the end' },
    { value: 'incoming', label: 'Upstream', description: 'Each route runs against lineage: the end feeds the start' },
    { value: 'any', label: 'Either way', description: 'Edges in either direction' },
]

const END_MODES: { value: 'named' | 'where'; label: string; description: string }[] = [
    { value: 'named', label: 'Named', description: 'Entities named by their path, or by URN' },
    { value: 'where', label: 'Any entity where…', description: 'Every entity meeting a condition' },
]


function endOf(p: PathPredicate, side: Side) {
    return side === 'source'
        ? { urns: p.sourceUrns ?? [], refs: p.sourceRefs ?? [], where: p.sourceWhere ?? null }
        : { urns: p.targetUrns ?? [], refs: p.targetRefs ?? [], where: p.targetWhere ?? null }
}

/** ``p`` with one end replaced, its reach cut to what the ends allow. */
function withEnd(p: PathPredicate, side: Side, refs: NodeRef[], where: Predicate | null): PathPredicate {
    const key = side === 'source' ? 'source' : 'target'
    const next = {
        ...p,
        [`${key}Urns`]: [],
        [`${key}Refs`]: refs.length ? refs : undefined,
        [`${key}Where`]: where ?? undefined,
    } as PathPredicate
    const cap = HOPS_CAP[(next.sourceWhere ? 1 : 0) + (next.targetWhere ? 1 : 0)]
    return next.maxHops && next.maxHops > cap ? { ...next, maxHops: cap } : next
}


export interface PathEditorProps {
    value: PathPredicate
    onChange: (next: Predicate) => void
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    onSubmit?: () => void
}


export const PathEditor: FC<PathEditorProps> = ({
    value, onChange, discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit,
}) => {
    const ctx = useContext(RelationContext)
    const nested = useMemo(() => ({ ...ctx, depth: ctx.depth + 1 }), [ctx])
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    const cap = HOPS_CAP[(value.sourceWhere ? 1 : 0) + (value.targetWhere ? 1 : 0)]
    const hops = Math.min(value.maxHops ?? 4, cap)

    const end = (side: Side, label: string) => {
        const { urns, refs, where } = endOf(value, side)
        const mode = where ? 'where' : 'named'
        return (
            <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                    <span className="w-10 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                        {label}
                    </span>
                    <OperatorMenu
                        value={mode} options={END_MODES} ariaLabel={`${label}: named or a condition`}
                        disabled={isRunning}
                        onChange={(next) => onChange(next === mode ? value : withEnd(value, side, [],
                            next === 'where' ? { kind: 'entityType', op: 'in', values: [] } : null))}
                    />
                </div>
                {mode === 'named' ? (
                    <NodeRefList
                        value={[...urns.map((urn) => ({ urn })), ...refs]}
                        disabled={isRunning}
                        onChange={(next) => onChange(withEnd(value, side, next, null))}
                    />
                ) : (
                    <div className="rounded-lg border border-glass-border/70 bg-canvas-base/30 p-2">
                        <RelationContext.Provider value={nested}>
                            <VisualQueryBuilder
                                predicate={where}
                                onSeed={(w) => onChange(withEnd(value, side, [], w ?? { kind: 'all' }))}
                                onCommit={(w) => onChange(withEnd(value, side, [], w ?? { kind: 'all' }))}
                                discovery={discovery}
                                knownEntityTypes={knownEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                onSubmit={onSubmit}
                            />
                        </RelationContext.Provider>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {end('source', 'From')}
            {end('target', 'To')}

            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
                <OperatorMenu value={value.direction ?? 'outgoing'} options={DIRECTION_OPTIONS}
                              ariaLabel="Direction" disabled={isRunning}
                              onChange={(direction) => onChange({ ...value, direction })} />
                <span>up to</span>
                <input type="number" min={1} max={cap} value={hops} aria-label="Most hops"
                       onChange={(e) => onChange({
                           ...value, maxHops: Math.min(cap, Math.max(1, Math.round(Number(e.target.value)) || 1)),
                       })}
                       className={cn(inputClass, 'w-16')} disabled={isRunning} />
                <span>hops, at most</span>
                <input type="number" min={1} max={MAX_PATHS} value={value.maxPaths ?? 32} aria-label="Most routes"
                       onChange={(e) => onChange({
                           ...value,
                           maxPaths: Math.min(MAX_PATHS, Math.max(1, Math.round(Number(e.target.value)) || 1)),
                       })}
                       className={cn(inputClass, 'w-16')} disabled={isRunning} />
                <span>routes</span>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                    Through edges
                </span>
                <EdgePredicateEditor
                    value={value.edgePredicate ?? null}
                    ctx={edgeCtx}
                    edgeTypeHint={value.edgeTypes ?? undefined}
                    onChange={(edge: EdgePredicateNode | null) => {
                        const { edgePredicate: _e, ...rest } = value
                        onChange(edge ? { ...rest, edgePredicate: edge } : rest)
                    }}
                />
            </div>
        </div>
    )
}
