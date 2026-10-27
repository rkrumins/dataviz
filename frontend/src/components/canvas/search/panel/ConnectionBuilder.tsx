/**
 * ConnectionBuilder — a Connections search in the Form: the edges from
 * entities meeting one condition to entities meeting another, through the
 * edges you choose.
 *
 *   FROM   ┌ nested builder ───────────────┐        1,204 entities
 *          │ Data type is  string           │
 *          └────────────────────────────────┘
 *     │    THROUGH  [Any link ▾]  [From → To │ Either way]
 *     │    Only edges where…  [edge filter]
 *     ▼
 *   TO     ┌ nested builder ───────────────┐           45 entities
 *          │ Parent where family is smith   │
 *          └────────────────────────────────┘
 *
 * Each end is edited by the same VisualQueryBuilder as an entity search,
 * "Inside a container named…" included, minus what one edge can't hold:
 * routes (a path, within N hops) and lineage traced from far away
 * (``RelationContext.end``). An empty end is any entity. Each end says how
 * many entities meet it, counted as the Sentence counts its clauses.
 */
import { ArrowDown, ArrowLeftRight, ArrowRight, ArrowUpDown } from 'lucide-react'
import { type FC, type ReactNode, useContext, useMemo } from 'react'

import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import type { EdgePredicateNode, EdgesDirection, EdgesPredicate, Predicate } from '@/types/search'

import { EdgePredicateEditor } from '../builder/editors/EdgePredicateEditor'
import type { EditorContext } from '../builder/editors'
import { requestPredicate } from '../searchRequest'

import { countId } from './counts/clauseItems'
import { UNCOUNTABLE_WORDS, whyUncountable } from './counts/countable'
import { useCounts } from './counts/useCounts'
import { EdgeSetPicker } from './EdgeSetPicker'
import type { LayerOption } from './layerOptions'
import { OperatorMenu } from './OperatorMenu'
import { RelationContext, type RelationDiscovery, useEdgeEditorContext } from './relationContext'
import { VisualQueryBuilder } from './VisualQueryBuilder'
import { EDGE_SET_OPTIONS, type EdgeSet } from './vocabulary/edgeWords'
import { WhatThisMeansDisclosure } from './WhatThisMeansDisclosure'


type End = 'sourceWhere' | 'targetWhere'

/** A Connections search walks every link unless told otherwise, so "Any
 *  link" leads. */
const SET_OPTIONS = [...EDGE_SET_OPTIONS].sort((a, b) => Number(b.value === 'links') - Number(a.value === 'links'))

const DIRECTION_CHOICES: SegmentedOption<EdgesDirection>[] = [
    { value: 'outgoing', label: 'From → To', icon: ArrowRight },
    { value: 'either', label: 'Either way', icon: ArrowLeftRight },
]


/** The edges a Connections search walks: every link unless it says. */
export function connectionSetOf(p: EdgesPredicate): EdgeSet {
    return p.edgeTypes ? 'types' : (p.edgeClass ?? 'links')
}

/** ``p`` through ``set`` instead — edge types none picked yet; any link,
 *  the default, left unsaid. */
export function withConnectionSet(p: EdgesPredicate, set: EdgeSet): EdgesPredicate {
    const { edgeClass: _c, edgeTypes: _t, ...rest } = p
    if (set === 'types') return { ...rest, edgeTypes: [] }
    return set === 'links' ? rest : { ...rest, edgeClass: set }
}

/** ``p`` with one end replaced: none is any entity. */
export function withEnd(p: EdgesPredicate, end: End, where: Predicate | null): EdgesPredicate {
    const { [end]: _old, ...rest } = p
    return where ? { ...rest, [end]: where } : rest
}


export interface ConnectionBuilderProps {
    value: EdgesPredicate
    /** A value typed — no step of its own in the undo history. */
    onSeed: (next: Predicate) => void
    /** A change of shape: a condition added or removed, the edges, the way. */
    onCommit: (next: Predicate) => void
    viewId: string
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    onSubmit?: () => void
}


/** What a condition in an end can't know on its own: it is the query's
 *  own, as the server holds it, but not in its top-level AND, and it holds
 *  no route. */
export function useEndContext() {
    const ctx = useContext(RelationContext)
    return useMemo(() => ({ ...ctx, top: false, end: true }), [ctx])
}


export const ConnectionBuilder: FC<ConnectionBuilderProps> = ({
    value, onSeed, onCommit, viewId, discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit,
}) => {
    const endCtx = useEndContext()
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    const counts = useEndCounts(viewId, value)

    const end = (key: End, label: string) => {
        const where = value[key] ?? null
        return (
            <section aria-label={label} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 px-0.5">
                    <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-accent-lineage">
                        {label}
                    </span>
                    <span className="text-[11px] text-ink-muted truncate">
                        {where ? 'entities that…' : 'any entity — add a condition to narrow it'}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-ink-muted">
                        {counts[key].text}
                    </span>
                </div>
                <div className="rounded-xl border border-glass-border/70 bg-canvas-base/30 p-2">
                    <RelationContext.Provider value={endCtx}>
                        <VisualQueryBuilder
                            predicate={where}
                            onSeed={(w) => onSeed(withEnd(value, key, w))}
                            onCommit={(w) => onCommit(withEnd(value, key, w))}
                            discovery={discovery}
                            knownEntityTypes={knownEntityTypes}
                            discoveredLayers={discoveredLayers}
                            isRunning={isRunning}
                            onSubmit={onSubmit}
                        />
                    </RelationContext.Provider>
                </div>
            </section>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            <WhatThisMeansDisclosure predicate={value} />
            {end('sourceWhere', 'From')}
            <ThroughEditor value={value} onSeed={onSeed} onCommit={onCommit} isRunning={isRunning} edgeCtx={edgeCtx} />
            {end('targetWhere', 'To')}
        </div>
    )
}


/** The edges between the two ends, on the line that joins them: which
 *  edges, which way, and what each must meet. */
export const ThroughEditor: FC<{
    value: EdgesPredicate
    onSeed: (next: Predicate) => void
    onCommit: (next: Predicate) => void
    isRunning: boolean
    edgeCtx: EditorContext
}> = ({ value, onSeed, onCommit, isRunning, edgeCtx }) => {
    const set = connectionSetOf(value)
    const either = value.direction === 'either'
    return (
        <div className="flex gap-2.5 pl-3">
            <div aria-hidden className="flex flex-col items-center pt-1 text-accent-lineage/70">
                <span className="w-px flex-1 bg-accent-lineage/30" />
                {either ? <ArrowUpDown className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
                <Row label="Through">
                    <OperatorMenu value={set} onChange={(next) => onCommit(withConnectionSet(value, next))}
                                  options={SET_OPTIONS} ariaLabel="Through which edges" disabled={isRunning} />
                    <Segmented options={isRunning ? DIRECTION_CHOICES.map((o) => ({ ...o, disabled: true }))
                        : DIRECTION_CHOICES}
                               value={value.direction ?? 'outgoing'} label="Which way"
                               onChange={(direction) => {
                                   const { direction: _d, ...rest } = value
                                   onCommit(direction === 'outgoing' ? rest : { ...rest, direction })
                               }} />
                </Row>
                {set === 'types' && (
                    <EdgeSetPicker value={value.edgeTypes ?? []} disabled={isRunning}
                                   onChange={(edgeTypes) => onCommit({ ...value, edgeTypes })} />
                )}
                {either && (
                    <p className="text-[10.5px] text-ink-muted/80">
                        Edges stored either way between them, each once — From and To may be the source
                        or the target.
                    </p>
                )}
                <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                        Only edges where…
                    </span>
                    <EdgePredicateEditor
                        value={value.edgePredicate ?? null}
                        ctx={edgeCtx}
                        edgeTypeHint={value.edgeTypes ?? undefined}
                        onChange={(edge: EdgePredicateNode | null) => {
                            const { edgePredicate: _e, ...rest } = value
                            onSeed(edge ? { ...rest, edgePredicate: edge } : rest)
                        }}
                    />
                </div>
            </div>
        </div>
    )
}


const Row: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
    <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-[64px] text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">{label}</span>
        {children}
    </div>
)


/** How many entities meet an end: in words — nothing where nothing is
 *  counted (live counts off, a share link), a reason where it can't be
 *  counted yet — and, once counted exactly, the number. */
export interface EndCount {
    text: string
    count: number | null
}

/** Each end's count, as the Sentence counts its clauses. An empty end — any
 *  entity — has none. */
export function useEndCounts(viewId: string, value: EdgesPredicate): Record<End, EndCount> {
    const { sourceWhere, targetWhere } = value
    const items = useMemo(() => [sourceWhere, targetWhere].flatMap((w) => (w && !whyUncountable(w, false)
        ? [{ id: countId(w), predicate: requestPredicate(w) }] : [])), [sourceWhere, targetWhere])
    const { counts, status } = useCounts(viewId, items)
    const of = (where: Predicate | null | undefined): EndCount => {
        const none = { text: '', count: null }
        if (!where) return none
        const why = whyUncountable(where, false)
        if (why) return why === 'unfinished' ? none : { text: UNCOUNTABLE_WORDS[why], count: null }
        const c = counts.get(countId(where))
        if (!c) return status === 'counting' ? { text: 'counting…', count: null } : none
        if (c.error) return none
        return {
            text: `${c.count.toLocaleString()}${c.complete ? '' : '+'} ${c.count === 1 ? 'entity' : 'entities'}`,
            count: c.complete ? c.count : null,
        }
    }
    return { sourceWhere: of(sourceWhere), targetWhere: of(targetWhere) }
}
