/**
 * RelationshipEditor — the body of a relationship row: which relatives
 * (parent, any ancestor, top-level container, child, any descendant,
 * sources, targets, either), how many must match (any / none / every one
 * / a count), how far (hops along lineage, levels up or down the tree),
 * through which edges, and the relative's own conditions — edited by the
 * same VisualQueryBuilder as the query itself, so a condition on a
 * relative can be anything a query can, relationships included.
 *
 *   HAS A ▾  PARENT ▾
 *   WHERE THE PARENT…
 *   ┌─ nested builder ───────────────────────────────┐
 *   │  Entity type is in [domain]                     │
 *   └─────────────────────────────────────────────────┘
 *
 * ``RelationContext`` (relationContext.ts) carries what a row can't know
 * on its own; ``RelationProvider`` sets it for a builder.
 */
import { type FC, type ReactNode, useContext, useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { EdgePredicateNode, Predicate, RelatedPredicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import { inputClass } from '../typed/fieldStyles'

import { OperatorMenu } from './OperatorMenu'
import type { LayerOption } from './layerOptions'
import {
    RelationContext,
    type RelationContextValue,
    type RelationDiscovery,
    useEdgeEditorContext,
} from './relationContext'
import {
    AXES,
    axisMeta,
    hopRange,
    maxHopsFor,
    RELATION_DEPTH_MAX,
    TREE_DEPTH_MAX,
    type RelationAxis,
} from './relations'
import { VisualQueryBuilder } from './VisualQueryBuilder'


/** Wraps a builder: ``rule`` for a display rule's, ``edges`` from discovery. */
export const RelationProvider: FC<{
    rule?: boolean
    viewId?: string | null
    edges?: RelationContextValue['edges']
    children: ReactNode
}> = ({ rule = false, viewId, edges, children }) => {
    const value = useMemo(() => ({ depth: 0, rule, viewId, edges }), [rule, viewId, edges])
    return <RelationContext.Provider value={value}>{children}</RelationContext.Provider>
}


type Lead = 'any' | 'none' | 'all' | 'count'

const LEAD_OPTIONS: { value: Lead; label: string; description: string }[] = [
    { value: 'any', label: 'Has a', description: 'At least one relative matches' },
    { value: 'none', label: 'Has no', description: 'No relative matches' },
    { value: 'all', label: 'Every', description: 'Every relative matches — and there is one' },
    { value: 'count', label: 'Count', description: 'How many relatives match' },
]

type CountOp = NonNullable<NonNullable<RelatedPredicate['count']>['op']>

const COUNT_OPTIONS: { value: CountOp; label: string }[] = [
    { value: 'gte', label: 'at least' },
    { value: 'gt', label: 'more than' },
    { value: 'eq', label: 'exactly' },
    { value: 'lte', label: 'at most' },
    { value: 'lt', label: 'fewer than' },
    { value: 'neq', label: 'other than' },
]

const AXIS_OPTIONS = AXES.map((a) => ({ value: a.axis, label: a.label, description: a.description }))


export interface RelationshipEditorProps {
    value: RelatedPredicate
    onChange: (next: Predicate) => void
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    onSubmit?: () => void
}


export const RelationshipEditor: FC<RelationshipEditorProps> = ({
    value, onChange, discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit,
}) => {
    const ctx = useContext(RelationContext)
    const meta = axisMeta(value.axis)
    const lead: Lead = value.count ? 'count' : (value.quantifier ?? 'any')
    const [lo, hi] = hopRange(value)
    const hopCap = maxHopsFor(value, { topLevel: ctx.depth === 0, rule: ctx.rule })
    const nested = useMemo(() => ({ ...ctx, depth: ctx.depth + 1 }), [ctx])
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)

    const setLead = (next: Lead) => {
        const { count: _c, quantifier: _q, ...rest } = value
        if (next === 'count') onChange({ ...rest, count: { op: 'gte', value: 1 } })
        else onChange(next === 'any' ? rest : { ...rest, quantifier: next })
    }
    /** Lineage hops cut to what the server allows where it stands. */
    const withinCap = (p: RelatedPredicate): RelatedPredicate => {
        if (!axisMeta(p.axis).lineage) return p
        const cap = maxHopsFor(p, { topLevel: ctx.depth === 0, rule: ctx.rule })
        const min = Math.min(p.minHops ?? 1, cap)
        const max = p.maxHops && Math.min(p.maxHops, cap)
        return { ...p, minHops: min > 1 ? min : undefined, maxHops: max && max > 1 ? max : undefined }
    }
    const setAxis = (axis: RelationAxis) => {
        const target = axisMeta(axis)
        const { minHops: _lo, maxHops: _hi, edge: _e, edgeTypes: _t, ...rest } = value
        // Hops, edge types and the edge filter belong to the axes that
        // take them; a change of axis keeps them only where they still apply.
        onChange(withinCap({
            ...rest, axis,
            ...(target.hops ? { minHops: value.minHops, maxHops: value.maxHops } : {}),
            ...(target.lineage ? { edge: value.edge, edgeTypes: value.edgeTypes } : {}),
        } as RelatedPredicate))
    }
    const setHops = (min: number, max: number | null) => onChange({
        ...value,
        minHops: min > 1 ? min : undefined,
        maxHops: max === null || (meta.lineage && max === min && min === 1) ? undefined : max,
    })
    const setWhere = (where: Predicate | null) => {
        const { where: _w, ...rest } = value
        // Naming the far end lets lineage go further; unnaming it, less.
        onChange(withinCap(where ? { ...rest, where } : rest))
    }
    const setEdge = (edge: EdgePredicateNode | null) => {
        const { edge: _e, ...rest } = value
        onChange(edge ? { ...rest, edge } : rest)
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <OperatorMenu value={lead} onChange={setLead} options={LEAD_OPTIONS}
                              ariaLabel="How many relatives" disabled={isRunning} />
                {value.count && (
                    <>
                        <OperatorMenu value={value.count.op ?? 'gte'}
                                      onChange={(op) => onChange({ ...value, count: { ...value.count!, op } })}
                                      options={COUNT_OPTIONS} ariaLabel="Count comparison"
                                      disabled={isRunning} />
                        <input type="number" min={0} value={value.count.value}
                               aria-label="Count"
                               onChange={(e) => onChange({
                                   ...value,
                                   count: { ...value.count!, value: Math.max(0, Number(e.target.value) || 0) },
                               })}
                               className={cn(inputClass, 'w-20')} disabled={isRunning} />
                    </>
                )}
                <OperatorMenu value={value.axis} onChange={setAxis} options={AXIS_OPTIONS}
                              ariaLabel="Which relatives" disabled={isRunning} />
            </div>

            {meta.hops && (
                <HopsField axis={value.axis} lineage={meta.lineage} lo={lo}
                           hi={meta.lineage || value.maxHops ? hi : null}
                           cap={meta.lineage ? hopCap : TREE_DEPTH_MAX}
                           onChange={setHops} disabled={isRunning} />
            )}

            {meta.lineage && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                        Through edges
                    </span>
                    <EdgePredicateEditor value={value.edge ?? null} onChange={setEdge} ctx={edgeCtx}
                                         edgeTypeHint={value.edgeTypes ?? undefined} />
                </div>
            )}

            <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                    {lead === 'all' ? `Every ${meta.noun}…` : `Where the ${meta.noun}…`}
                </span>
                {ctx.depth + 1 < RELATION_DEPTH_MAX || !containsRelation(value.where) ? (
                    <div className="rounded-lg border border-glass-border/70 bg-canvas-base/30 p-2">
                        <RelationContext.Provider value={nested}>
                            <VisualQueryBuilder
                                predicate={value.where ?? null}
                                onSeed={setWhere}
                                onCommit={setWhere}
                                discovery={discovery}
                                knownEntityTypes={knownEntityTypes}
                                discoveredLayers={discoveredLayers}
                                isRunning={isRunning}
                                onSubmit={onSubmit}
                            />
                        </RelationContext.Provider>
                    </div>
                ) : (
                    <p className="text-[11px] text-ink-muted">
                        Relationships nest {RELATION_DEPTH_MAX} deep at most — edit this one in Code.
                    </p>
                )}
                {!value.where && (
                    <p className="text-[10.5px] text-ink-muted/80">
                        No condition: any {meta.noun} will do.
                    </p>
                )}
            </div>
        </div>
    )
}


function containsRelation(p: Predicate | null | undefined): boolean {
    if (!p) return false
    if (p.kind === 'related') return true
    return p.kind === 'group' && p.children.some(containsRelation)
}


const HopsField: FC<{
    axis: RelationAxis
    lineage: boolean
    lo: number
    /** None for a tree axis looking any depth down or up. */
    hi: number | null
    cap: number
    onChange: (min: number, max: number | null) => void
    disabled?: boolean
}> = ({ axis, lineage, lo, hi, cap, onChange, disabled }) => {
    const clamp = (n: number) => Math.min(cap, Math.max(1, Math.round(n) || 1))
    return (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
            <span className="text-[10px] font-mono uppercase tracking-[0.14em]">
                {lineage ? 'Hops' : 'Levels'}
            </span>
            <input type="number" min={1} max={cap} value={lo} aria-label={`Fewest ${lineage ? 'hops' : 'levels'}`}
                   onChange={(e) => {
                       const min = clamp(Number(e.target.value))
                       onChange(min, hi === null ? null : Math.max(min, hi))
                   }}
                   className={cn(inputClass, 'w-16')} disabled={disabled} />
            <span>to</span>
            <input type="number" min={lo} max={cap} value={hi ?? ''} placeholder={lineage ? '' : 'any'}
                   aria-label={`Most ${lineage ? 'hops' : 'levels'}`}
                   onChange={(e) => {
                       const raw = e.target.value
                       onChange(lo, raw === '' && !lineage ? null : Math.max(lo, clamp(Number(raw))))
                   }}
                   className={cn(inputClass, 'w-16')} disabled={disabled} />
            {lineage && (
                <span className="text-[10.5px] text-ink-muted/80">
                    up to {cap}{cap < 10 && axis !== 'neighbor' ? ' (name the far end to go further)' : ''}
                </span>
            )}
        </div>
    )
}
