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
import { ArrowLeft, ArrowLeftRight, ArrowRight, Cable, ChevronDown, Link2, Plus, SlidersHorizontal, Workflow } from 'lucide-react'
import { type FC, type ReactNode, useContext, useMemo, useState } from 'react'

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import { cn } from '@/lib/utils'
import type { EdgePredicateNode, Predicate, RelatedPredicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import { inputClass } from '../typed/fieldStyles'

import { EdgeSetPicker } from './EdgeSetPicker'
import { OperatorMenu } from './OperatorMenu'
import { RelationDiagram } from './RelationDiagram'
import { TypePicker } from './sentence/editors'
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
    RELATION_FAR_END_MAX_HOPS,
    TREE_DEPTH_MAX,
    throughOf,
    withinHopCap,
    type LinkDirection,
    type RelationAxis,
    type Through,
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

const THROUGH_CHOICES: SegmentedOption<Through>[] = [
    { value: 'lineage', label: 'Lineage', icon: Workflow },
    { value: 'links', label: 'Any link', icon: Link2 },
    { value: 'types', label: 'Edge types', icon: Cable },
]

const DIRECTION_CHOICES: SegmentedOption<LinkDirection>[] = [
    { value: 'out', label: 'Outgoing', icon: ArrowRight },
    { value: 'in', label: 'Incoming', icon: ArrowLeft },
    { value: 'both', label: 'Either way', icon: ArrowLeftRight },
]

/** Choices a running search can't change. */
function held<T extends string>(options: SegmentedOption<T>[], disabled: boolean): SegmentedOption<T>[] {
    return disabled ? options.map((o) => ({ ...o, disabled: true })) : options
}


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
    const stands = { topLevel: ctx.depth === 0 && ctx.top !== false, rule: ctx.rule }
    const hopCap = maxHopsFor(value, stands)
    const nested = useMemo(() => ({ ...ctx, depth: ctx.depth + 1 }), [ctx])
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    // Open on what still needs saying: edge types to pick.
    const [open, setOpen] = useState(() => value.edgeTypes?.length === 0)
    const [builder, setBuilder] = useState(false)
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

    // A relative named by its types alone takes one picker; anything more,
    // or asked for, the full builder.
    const typesOnly = builder ? null : onlyTypes(value.where as Predicate | undefined)
    const container = value.axis === 'parent' || value.axis === 'ancestor' || value.axis === 'root'
    const several = lead === 'all' || (lead === 'count' && value.count?.value !== 1)
    const relative = container ? (several ? 'containers' : 'container') : (several ? 'entities' : 'entity')
    const summary = optionsSummary(value)

    return (
        <div className="flex flex-col gap-3">
            {!hideWhere && <RelationDiagram value={value} onEdit={summary ? () => setOpen(true) : undefined} />}
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
                {!hideWhere && (
                    <span className="text-[11.5px] text-ink-muted">{relative} {typesOnly ? 'of type' : 'that…'}</span>
                )}
            </div>

            {!hideWhere && typesOnly && (
                <div className="flex flex-col gap-1.5">
                    <TypePicker value={typesOnly} types={knownEntityTypes}
                                placeholder={`Any ${container ? 'container' : 'entity'} — pick types to narrow…`}
                                onChange={(types) => setWhere(types.length
                                    ? { kind: 'entityType', op: 'in', values: types } : null)} />
                    <button type="button" onClick={() => setBuilder(true)} disabled={isRunning}
                            title="A tag, a property, what they connect to…"
                            className="inline-flex items-center gap-1 self-start rounded-md text-[11px] font-medium text-accent-lineage hover:underline">
                        <Plus className="h-3 w-3" aria-hidden />
                        Add a condition on them
                    </button>
                </div>
            )}

            {!hideWhere && !typesOnly && <div className="flex flex-col gap-1.5">
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
                        className="flex items-center gap-1.5 self-start rounded-md text-[11px] text-ink-muted hover:text-ink">
                    {/* The picture says the rest; the Sentence's popup has none. */}
                    {hideWhere ? <span>{summary}</span>
                        : <SlidersHorizontal className="h-3 w-3 text-accent-lineage" aria-hidden />}
                    <span className="font-medium text-accent-lineage">{open ? 'Fewer options' : 'More options'}</span>
                    <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
                </button>
            )}

            {summary && open && (
                <div className="flex flex-col gap-3 rounded-xl border border-glass-border/60 bg-canvas-base/40 p-3">
                    {meta.hops && (
                        <StepsField lineage={meta.lineage} lo={lo}
                                    hi={meta.lineage || value.maxHops ? hi : null}
                                    cap={meta.lineage ? hopCap : TREE_DEPTH_MAX}
                                    further={!ctx.rule}
                                    onChange={setHops} disabled={isRunning} />
                    )}
                    {meta.lineage && (
                        <>
                            <Option label="Through">
                                <Segmented options={held(THROUGH_CHOICES, isRunning)} value={through}
                                           onChange={setThrough} label="Through which edges" />
                            </Option>
                            {through === 'types' && (
                                <EdgeSetPicker value={value.edgeTypes ?? []} links disabled={isRunning}
                                               onChange={(edgeTypes) => onChange({ ...value, edgeTypes })} />
                            )}
                            {through !== 'lineage' && (
                                <Option label="Direction">
                                    <Segmented options={held(DIRECTION_CHOICES, isRunning)}
                                               value={linkDirection(value.axis)} onChange={setDirection}
                                               label="Which way" />
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



/** The entity types a relative's condition names when that is all it
 *  says — none for no condition — else null. */
function onlyTypes(where: Predicate | undefined): string[] | null {
    if (!where) return []
    return where.kind === 'entityType' && (where.op ?? 'in') === 'in' ? where.values : null
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


interface StepsProps {
    lineage: boolean
    lo: number
    /** None for a tree axis looking any depth down or up. */
    hi: number | null
    cap: number
    /** Whether it could go further elsewhere — as "at least one", at the
     *  top of the query (a display rule's never does). */
    further: boolean
    onChange: (min: number, max: number | null) => void
    disabled?: boolean
}

/** How far: the usual reaches as one choice each — 1 step, up to 2, up to
 *  3… or any depth down the tree — and a range of your own a click away. */
const StepsField: FC<StepsProps> = (props) => {
    const { lineage, lo, hi, cap, further, onChange, disabled } = props
    const choices: SegmentedOption<string>[] = [
        ...(lineage ? [1, 2, 3, 5, 10] : [1, 2, 3]).filter((n) => n <= cap).map((n) => ({
            value: String(n), label: n > 1 ? `Up to ${n}` : lineage ? '1 step' : '1 level',
        })),
        ...(lineage ? [] : [{ value: 'any', label: 'Any depth' }]),
    ]
    const current = lo === 1 ? (hi === null ? 'any' : String(hi)) : ''
    const [custom, setCustom] = useState(() => !choices.some((c) => c.value === current))
    return (
        <Option label={lineage ? 'Steps' : 'Levels'}>
            {custom ? <HopsField {...props} />
                : <Segmented options={held(choices, !!disabled)} value={current}
                             onChange={(v) => onChange(1, v === 'any' ? null : Number(v))}
                             label={lineage ? 'How many steps' : 'How many levels'} />}
            <button type="button" onClick={() => setCustom(!custom)} disabled={disabled}
                    className="text-[10.5px] font-medium text-accent-lineage hover:underline">
                {custom ? 'Usual reaches' : 'Custom range'}
            </button>
            {lineage && !custom && cap < RELATION_FAR_END_MAX_HOPS && further && (
                <span className="basis-full pl-[78px] text-[10.5px] text-ink-muted/80">
                    Up to {RELATION_FAR_END_MAX_HOPS} steps for “at least one” at the top of the search
                </span>
            )}
        </Option>
    )
}


const HopsField: FC<StepsProps> = ({ lineage, lo, hi, cap, further, onChange, disabled }) => {
    const clamp = (n: number) => Math.min(cap, Math.max(1, Math.round(n) || 1))
    const unit = lineage ? 'steps' : 'levels'
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
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
                    up to {cap}{cap < RELATION_FAR_END_MAX_HOPS && further
                        ? ` (${RELATION_FAR_END_MAX_HOPS} for “at least one” at the top of the search)` : ''}
                </span>
            )}
        </span>
    )
}
