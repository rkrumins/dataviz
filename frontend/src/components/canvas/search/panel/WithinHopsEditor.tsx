/**
 * WithinHopsEditor — the body of a "Within N hops of…" row: everything a
 * few edges away from the entities it names, through the edges it walks.
 *
 *   NEAR  Sales / orders
 *   [Either way ▾]  up to [2] hops through  [Lineage ▾]
 *   THROUGH EDGES  confidence ≥ 0.8
 *
 * The entities are picked by name, as a path's ends are.
 */
import type { FC } from 'react'

import { cn } from '@/lib/utils'
import type { EdgePredicateNode, NodeRef, Predicate, WithinHopsPredicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import { inputClass } from '../typed/fieldStyles'

import { EdgeSetPicker } from './EdgeSetPicker'
import { NodeRefList } from './NodeRefPicker'
import { OperatorMenu } from './OperatorMenu'
import type { LayerOption } from './layerOptions'
import { type RelationDiscovery, useEdgeEditorContext } from './relationContext'
import { EDGE_SET_OPTIONS, edgeSetOf, withEdgeSet } from './vocabulary/edgeWords'


/** How far it may reach: the server's cap (`WithinHopsPredicate`). */
const HOPS_MAX = 10

const DIRECTION_OPTIONS: { value: NonNullable<WithinHopsPredicate['direction']>; label: string; description: string }[] = [
    { value: 'both', label: 'Either way', description: 'Edges in either direction' },
    { value: 'out', label: 'Downstream', description: 'Only along the edges leaving them' },
    { value: 'in', label: 'Upstream', description: 'Only against the edges: what leads to them' },
]


export interface WithinHopsEditorProps {
    value: WithinHopsPredicate
    onChange: (next: Predicate) => void
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    autoFocus?: boolean
}


export const WithinHopsEditor: FC<WithinHopsEditorProps> = ({
    value, onChange, discovery, knownEntityTypes, discoveredLayers, isRunning, autoFocus,
}) => {
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    const set = edgeSetOf(value)
    const near: NodeRef[] = [...(value.urns ?? []).map((urn) => ({ urn })), ...(value.refs ?? [])]

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">Near</span>
                <NodeRefList
                    value={near}
                    autoFocus={autoFocus}
                    disabled={isRunning}
                    onChange={(refs) => onChange({ ...value, urns: [], refs: refs.length ? refs : undefined })}
                />
            </div>

            <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
                    <OperatorMenu value={value.direction ?? 'both'} options={DIRECTION_OPTIONS}
                                  ariaLabel="Direction" disabled={isRunning}
                                  onChange={(direction) => onChange({ ...value, direction })} />
                    <span>up to</span>
                    <input type="number" min={1} max={HOPS_MAX} value={value.hops} aria-label="Most hops"
                           onChange={(e) => onChange({
                               ...value, hops: Math.min(HOPS_MAX, Math.max(1, Math.round(Number(e.target.value)) || 1)),
                           })}
                           className={cn(inputClass, 'w-16')} disabled={isRunning} />
                    <span>hops through</span>
                    <OperatorMenu value={set} options={EDGE_SET_OPTIONS} ariaLabel="Through which edges"
                                  disabled={isRunning} onChange={(next) => onChange(withEdgeSet(value, next))} />
                </div>
                {set === 'types' && (
                    <EdgeSetPicker value={value.edgeTypes ?? []} disabled={isRunning}
                                   onChange={(edgeTypes) => onChange({ ...value, edgeTypes })} />
                )}
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                    Through edges
                </span>
                <EdgePredicateEditor
                    value={value.edgePredicate ?? null}
                    ctx={edgeCtx}
                    edgeTypeHint={value.edgeTypes ?? undefined}
                    onChange={(edge: EdgePredicateNode | null) => onChange({
                        ...value, edgePredicate: edge ?? undefined,
                    })}
                />
            </div>
        </div>
    )
}
