/**
 * ConnectionSentence — a Connections search in the Sentence view: each end
 * a sentence of its own, read from its first word, with the edges between
 * them on the line that joins the two.
 *
 *   Find connections
 *   From [Columns]                                       55 ▇▇
 *     that [are tagged] [#PII]                            3 ▏
 *    │  THROUGH  [Any link ▾]  [From → To │ Either way]
 *   To [Anything]
 *     that [has a parent] ↳ that [is tagged] [#Finance]  16 ▇
 *
 * Each end is the Sentence builder itself, so its clauses, tokens and
 * counts behave as an entity search's do, held to what an end may hold
 * (``useEndContext``).
 */
import { ArrowLeftRight, ArrowRight, CircleDashed } from 'lucide-react'
import type { FC } from 'react'

import type { EdgesPredicate, Predicate } from '@/types/search'

import { connectionSetOf, ThroughEditor, useEndContext, useEndCounts, withEnd } from './ConnectionBuilder'
import type { LayerOption } from './layerOptions'
import { RelationContext, type RelationDiscovery, useEdgeEditorContext } from './relationContext'
import { listedClauses } from './sentence/clauseModel'
import { TypeIcon } from './sentence/editors'
import { SentenceBuilder } from './sentence/SentenceBuilder'
import { useTypeName } from './sentence/useTypeName'
import { edgeSetPhrase } from './vocabulary/edgeWords'
import { WhatThisMeansDisclosure } from './WhatThisMeansDisclosure'


export interface ConnectionSentenceProps {
    viewId: string
    value: EdgesPredicate
    onSeed: (next: Predicate) => void
    onCommit: (next: Predicate) => void
    discovery: RelationDiscovery
    knownEntityTypes: string[]
    presentEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning: boolean
    onSubmit?: () => void
    onEditInCode: () => void
}


export const ConnectionSentence: FC<ConnectionSentenceProps> = ({
    viewId, value, onSeed, onCommit, discovery, knownEntityTypes, presentEntityTypes, discoveredLayers,
    isRunning, onSubmit, onEditInCode,
}) => {
    const endCtx = useEndContext()
    const edgeCtx = useEdgeEditorContext(discovery, knownEntityTypes, discoveredLayers)
    const end = (key: 'sourceWhere' | 'targetWhere', lead: string) => (
        <section aria-label={lead}>
            <RelationContext.Provider value={endCtx}>
                <SentenceBuilder
                    viewId={viewId}
                    predicate={value[key] ?? null}
                    subjectLead={lead}
                    onSeed={(w) => onSeed(withEnd(value, key, w))}
                    onCommit={(w) => onCommit(withEnd(value, key, w))}
                    discovery={discovery}
                    knownEntityTypes={knownEntityTypes}
                    presentEntityTypes={presentEntityTypes}
                    discoveredLayers={discoveredLayers}
                    isRunning={isRunning}
                    onSubmit={onSubmit}
                    onEditInCode={onEditInCode}
                    showMap={false}
                />
            </RelationContext.Provider>
        </section>
    )
    return (
        <div className="flex flex-col gap-2">
            <WhatThisMeansDisclosure predicate={value} />
            <ConnectionMap viewId={viewId} value={value} />
            <p className="px-1 text-[13px] font-display font-semibold text-ink">Find connections</p>
            {end('sourceWhere', 'From')}
            <ThroughEditor value={value} onSeed={onSeed} onCommit={onCommit} isRunning={isRunning} edgeCtx={edgeCtx} />
            {end('targetWhere', 'To')}
        </div>
    )
}


/** The connection's shape: From and To side by side — each by its types,
 *  with how many entities meet it — joined by the edges between them. */
function ConnectionMap({ viewId, value }: { viewId: string; value: EdgesPredicate }) {
    const counts = useEndCounts(viewId, value)
    const set = connectionSetOf(value)
    const label = edgeSetPhrase({ edgeClass: set === 'types' ? undefined : set, edgeTypes: value.edgeTypes })
    return (
        <div role="img" aria-label={`Connections from ${counts.sourceWhere.text || 'any entity'} to ${
            counts.targetWhere.text || 'any entity'}, through ${label}`}
             className="flex items-center gap-1.5 rounded-xl border border-glass-border/60 bg-gradient-to-r from-accent-lineage/[0.07] via-transparent to-transparent px-2.5 py-2.5">
            <MapEnd lead="From" where={value.sourceWhere ?? null} count={counts.sourceWhere.count} />
            <div className="flex min-w-[64px] flex-1 flex-col items-center gap-0.5 px-1">
                <span className="max-w-full truncate rounded-md px-1.5 text-[11px] font-semibold text-ink">{label}</span>
                <span className="flex w-full items-center text-accent-lineage/70">
                    <span className="h-px flex-1 bg-current" />
                    {value.direction === 'either'
                        ? <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        : <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                </span>
            </div>
            <MapEnd lead="To" where={value.targetWhere ?? null} count={counts.targetWhere.count} />
        </div>
    )
}


/** An end by its types — anything, with none — and its exact count once known. */
function MapEnd({ lead, where, count }: { lead: string; where: Predicate | null; count: number | null }) {
    const typeName = useTypeName()
    const types = listedClauses(where).subject?.types ?? []
    const more = listedClauses(where).clauses.length
    return (
        <div className="flex min-w-0 max-w-[45%] flex-col gap-0.5 rounded-lg border border-glass-border/60 bg-canvas-elevated/60 px-2 py-1.5">
            <span className="text-[9.5px] font-mono uppercase tracking-[0.14em] text-accent-lineage">{lead}</span>
            <span className="flex min-w-0 items-center gap-1 text-[12px] font-medium text-ink">
                {types.length ? <TypeIcon type={types[0]} /> : <CircleDashed className="h-3.5 w-3.5 shrink-0 text-ink-muted" />}
                <span className="truncate">{types.length ? types.map((t) => typeName(t, true)).join(' or ') : 'Anything'}</span>
                {count !== null && (
                    <span className="ml-auto shrink-0 pl-1 text-[10.5px] tabular-nums text-ink-muted">
                        {count.toLocaleString()}
                    </span>
                )}
            </span>
            {more > 0 && (
                <span className="truncate text-2xs text-ink-muted">
                    {more} more condition{more === 1 ? '' : 's'}
                </span>
            )}
        </div>
    )
}
