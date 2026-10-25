/**
 * RelationshipEditor — the body of a relationship row, read as what the
 * entity does to its relatives: a verb (is inside, contains, feeds, is fed
 * by, is linked to), how many of them must match (at least one, none, only
 * these, a number) and the conditions they meet — edited by the same
 * VisualQueryBuilder as the query itself, so a relative's condition can be
 * anything a query can, relationships included.
 *
 *   [Feeds ▾] [at least one ▾]  entity that…
 *   ┌─ nested builder ───────────────────────────────┐
 *   │  Entity type is in [dashboard]                  │
 *   └─────────────────────────────────────────────────┘
 *   1–3 steps · lineage                  More options ▾
 *
 * More options: how many steps (or levels), through which edges — lineage,
 * every link, or edge types picked by name — which way a link is followed,
 * and conditions every edge walked must meet. Picking every link or edge
 * types turns Feeds / Is fed by into Is linked to, outgoing or incoming:
 * feeding is what lineage does. ``RelationContext`` (relationContext.ts)
 * carries what a row can't know on its own; ``RelationProvider`` sets it.
 */
import { ChevronDown } from 'lucide-react'
import { type FC, type ReactNode, useContext, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { EdgePredicateNode, Predicate, RelatedPredicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import { inputClass } from '../typed/fieldStyles'

import { EdgeSetPicker } from './EdgeSetPicker'
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
    DIRECTION_AXIS,
    hopRange,
    linkDirection,
    linkVerb,
    maxHopsFor,
    optionsSummary,
    RELATION_DEPTH_MAX,
    TREE_DEPTH_MAX,
    throughOf,
    withinHopCap,
    type LinkDirection,
    type RelationAxis,
    type Through,
} from './relations'
import { DEGREE_DIRECTION_OPTIONS, EDGE_SET_OPTIONS } from './vocabulary/edgeWords'
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
    { value: 'any', label: 'at least one', description: 'At least one of them matches' },
    { value: 'none', label: 'no', description: 'None of them matches' },
    { value: 'all', label: 'only', description: 'Every one of them matches — and there is one' },
    { value: 'count', label: 'a number of', description: 'How many of them match' },
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

const VERB_OPTIONS = AXES.map((a) => ({
    value: a.axis, label: a.label, description: a.description,
    group: a.group === 'hierarchy' ? 'In the hierarchy' : 'Connected',
}))

const THROUGH_OPTIONS = EDGE_SET_OPTIONS.filter((o) =>
    o.value === 'lineage' || o.value === 'links' || o.value === 'types') as { value: Through; label: string; description: string }[]


export interface RelationshipEditorProps {
    value: RelatedPredicate
    onChange: (next: Predicate) => void
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    onSubmit?: () => void
    /** Leave out the relative's own condition — the Sentence builder shows
     *  it as the lines under the relationship. */
    hideWhere?: boolean
}


export const RelationshipEditor: FC<RelationshipEditorProps> = ({
    value, onChange, discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit, hideWhere = false,
}) => {
    const ctx = useContext(RelationContext)
    const meta = axisMeta(value.axis)
    const link = linkVerb(value)
    const through = throughOf(value)
    const lead: Lead = value.count ? 'count' : (value.quantifier ?? 'any')
    const [lo, hi] = hopRange(value)
    const stands = { topLevel: ctx.depth === 0, rule: ctx.rule }
    const hopCap = maxHopsFor(value, stands)
    const nested = useMemo(() => ({ ...ctx, depth: ctx.depth + 1 }), [ctx])
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    // Open on what still needs saying: edge types to pick.
    const [open, setOpen] = useState(() => value.edgeTypes?.length === 0)
    // "Is linked to" stands for every link: lineage either way included.
    const verb: RelationAxis = link === 'linked' ? 'neighbor' : value.axis

    const setLead = (next: Lead) => {
        const { count: _c, quantifier: _q, ...rest } = value
        if (next === 'count') onChange({ ...rest, count: { op: 'gte', value: 1 } })
        else onChange(next === 'any' ? rest : { ...rest, quantifier: next })
    }
    const setVerb = (axis: RelationAxis) => {
        if (axis === verb) return
        const target = axisMeta(axis)
        const { minHops: _lo, maxHops: _hi, edge: _e, edgeTypes: _t, edgeClass: _c, ...rest } = value
        // Hops and the edge filter belong to the axes that take them; a
        // change of verb keeps them only where they still apply.
        const kept = {
            ...(target.hops && value.minHops ? { minHops: value.minHops } : {}),
            ...(target.hops && value.maxHops ? { maxHops: value.maxHops } : {}),
            ...(target.lineage && value.edge ? { edge: value.edge } : {}),
        }
        // Is linked to: either way, through every link.
        const next = axis === 'neighbor'
            ? { ...rest, ...kept, axis, edgeClass: 'links' as const }
            : { ...rest, ...kept, axis }
        onChange(withinHopCap(next as RelatedPredicate, stands))
    }
    const setThrough = (next: Through) => {
        const { edgeTypes: _t, edgeClass: _c, ...rest } = value
        onChange(next === 'lineage' ? rest
            : next === 'links' ? { ...rest, edgeClass: 'links' } : { ...rest, edgeTypes: [] })
        if (next === 'types') setOpen(true)
    }
    const setDirection = (direction: LinkDirection) =>
        onChange(withinHopCap({ ...value, axis: DIRECTION_AXIS[direction] }, stands))
    const setHops = (min: number, max: number | null) => {
        const { minHops: _lo, maxHops: _hi, ...rest } = value
        const most = max === null || (meta.lineage && max === min && min === 1) ? undefined : max
        onChange({ ...rest, ...(min > 1 ? { minHops: min } : {}), ...(most ? { maxHops: most } : {}) })
    }
    const setWhere = (where: Predicate | null) => {
        const { where: _w, ...rest } = value
        // Naming the far end lets lineage go further; unnaming it, less.
        onChange(withinHopCap(where ? { ...rest, where } : rest, stands))
    }
    const setEdge = (edge: EdgePredicateNode | null) => {
        const { edge: _e, ...rest } = value
        onChange(edge ? { ...rest, edge } : rest)
    }

    const container = value.axis === 'parent' || value.axis === 'ancestor' || value.axis === 'root'
    const several = lead === 'all' || (lead === 'count' && value.count?.value !== 1)
    const relative = container ? (several ? 'containers' : 'container') : (several ? 'entities' : 'entity')
    const summary = optionsSummary(value)

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <OperatorMenu value={verb} onChange={setVerb} options={VERB_OPTIONS}
                              ariaLabel="How it is related" disabled={isRunning} />
                <OperatorMenu value={lead} onChange={setLead} options={LEAD_OPTIONS}
                              ariaLabel="How many of them" disabled={isRunning} />
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
                {!hideWhere && <span className="text-[11.5px] text-ink-muted">{relative} that…</span>}
            </div>

            {!hideWhere && <div className="flex flex-col gap-1.5">
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
                        No condition: any {container ? 'container' : 'entity'} will do.
                    </p>
                )}
            </div>}

            {summary && (
                <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                        className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted hover:text-ink">
                    <span>{summary}</span>
                    <span className="text-accent-lineage">{open ? 'Fewer options' : 'More options'}</span>
                    <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
                </button>
            )}

            {summary && open && (
                <div className="flex flex-col gap-3 rounded-lg border border-glass-border/60 p-2.5">
                    {meta.hops && (
                        <HopsField lineage={meta.lineage} lo={lo}
                                   hi={meta.lineage || value.maxHops ? hi : null}
                                   cap={meta.lineage ? hopCap : TREE_DEPTH_MAX}
                                   named={value.axis !== 'neighbor'}
                                   onChange={setHops} disabled={isRunning} />
                    )}
                    {meta.lineage && (
                        <>
                            <Option label="Through">
                                <OperatorMenu value={through} onChange={setThrough} options={THROUGH_OPTIONS}
                                              ariaLabel="Through which edges" disabled={isRunning} />
                            </Option>
                            {through === 'types' && (
                                <EdgeSetPicker value={value.edgeTypes ?? []} links disabled={isRunning}
                                               onChange={(edgeTypes) => onChange({ ...value, edgeTypes })} />
                            )}
                            {through !== 'lineage' && (
                                <Option label="Direction">
                                    <OperatorMenu value={linkDirection(value.axis)} onChange={setDirection}
                                                  options={DEGREE_DIRECTION_OPTIONS} ariaLabel="Which way"
                                                  disabled={isRunning} />
                                </Option>
                            )}
                            <div className="flex flex-col gap-1.5">
                                <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                                    Only follow edges where…
                                </span>
                                <EdgePredicateEditor value={value.edge ?? null} onChange={setEdge} ctx={edgeCtx}
                                                     edgeTypeHint={value.edgeTypes ?? undefined} />
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}



function containsRelation(p: Predicate | null | undefined): boolean {
    if (!p) return false
    if (p.kind === 'related') return true
    return p.kind === 'group' && p.children.some(containsRelation)
}


const Option: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
    <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-[72px] text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
            {label}
        </span>
        {children}
    </div>
)


const HopsField: FC<{
    lineage: boolean
    lo: number
    /** None for a tree axis looking any depth down or up. */
    hi: number | null
    cap: number
    /** Whether naming the far end could let it go further. */
    named: boolean
    onChange: (min: number, max: number | null) => void
    disabled?: boolean
}> = ({ lineage, lo, hi, cap, named, onChange, disabled }) => {
    const clamp = (n: number) => Math.min(cap, Math.max(1, Math.round(n) || 1))
    const unit = lineage ? 'steps' : 'levels'
    return (
        <Option label={lineage ? 'Steps' : 'Levels'}>
            <input type="number" min={1} max={cap} value={lo} aria-label={`Fewest ${unit}`}
                   onChange={(e) => {
                       const min = clamp(Number(e.target.value))
                       onChange(min, hi === null ? null : Math.max(min, hi))
                   }}
                   className={cn(inputClass, 'w-16')} disabled={disabled} />
            <span className="text-[11.5px] text-ink-muted">to</span>
            <input type="number" min={lo} max={cap} value={hi ?? ''} placeholder={lineage ? '' : 'any'}
                   aria-label={`Most ${unit}`}
                   onChange={(e) => {
                       const raw = e.target.value
                       onChange(lo, raw === '' && !lineage ? null : Math.max(lo, clamp(Number(raw))))
                   }}
                   className={cn(inputClass, 'w-16')} disabled={disabled} />
            {lineage && (
                <span className="text-[10.5px] text-ink-muted/80">
                    up to {cap}{cap < 10 && named ? ' (name the far end to go further)' : ''}
                </span>
            )}
        </Option>
    )
}
