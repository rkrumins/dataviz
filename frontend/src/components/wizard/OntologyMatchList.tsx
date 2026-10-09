/**
 * OntologyMatchList — the semantic layers, ranked by how well each fits a graph, as
 * cards a person picks one of: the "none" choice first, then the best fits, the rest
 * a click away. Extracted from the Add/Move Data Source wizard so a new data source
 * copied from a view package is offered its layers the same way — one look, one
 * meaning, the same numbers.
 *
 * The scores come from {@link useOntologyMatches}. Until they're in (or when they
 * can't be had), the cards degrade to plain ones: the list is still a manual choice.
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
// The same coverage visuals the onboarding wizard uses — one look, one meaning.
import {
    CoverageRing, MiniBar, coverageColor, coverageBarClass,
} from '@/components/admin/AssetOnboardingWizard/steps/CoverageVisuals'
import type { OntologyDefinitionResponse, OntologyMatchResult } from '@/services/ontologyDefinitionService'
import { bestFitId, type OntologyMatchState } from './useOntologyMatches'

export function OntologyMatchList({ ontologies, matching, selectedId, onPick, none }: {
    ontologies: OntologyDefinitionResponse[]
    matching: Pick<OntologyMatchState, 'phase' | 'matches' | 'best'>
    /** The chosen layer's id; '' for the "none" card. */
    selectedId: string
    onPick: (ontologyId: string) => void
    /** The card that picks no layer at all ('' ). */
    none: { title: string; subtitle: string; meta: string }
}) {
    const scoreOf = useMemo(() => {
        const map = new Map<string, OntologyMatchResult>()
        for (const m of matching.matches) map.set(m.ontologyId, m)
        return map
    }, [matching.matches])

    // Rank the cards by fit, not by creation order.
    const rankedOntologies = useMemo(() => {
        return [...ontologies].sort((a, b) => {
            const sa = scoreOf.get(a.id)?.jaccardScore ?? -1
            const sb = scoreOf.get(b.id)?.jaccardScore ?? -1
            return sb - sa
        })
    }, [ontologies, scoreOf])

    // Three is the answer, not a list. Dumping thirteen layers — ten of which don't
    // fit — makes the user do the ranking we just did for them. The rest stay one
    // click away, paginated, and carry the SAME numbers and warnings: a layer is
    // only fairly rejected if you can see why.
    const TOP_N = 3
    const PAGE_SIZE = 4
    const [showAll, setShowAll] = useState(false)
    const [page, setPage] = useState(0)

    const topMatches = rankedOntologies.slice(0, TOP_N)
    const restMatches = rankedOntologies.slice(TOP_N)
    const pageCount = Math.max(1, Math.ceil(restMatches.length / PAGE_SIZE))
    const pagedRest = restMatches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

    // A layer chosen from deep in the list must stay visible when the list collapses.
    const selectedIsHidden = Boolean(
        selectedId && !showAll && restMatches.some(o => o.id === selectedId),
    )

    const bestId = bestFitId(matching)

    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <OntologyCard
                    selected={selectedId === ''}
                    onClick={() => onPick('')}
                    title={none.title}
                    subtitle={none.subtitle}
                    meta={none.meta}
                    dashed
                />

                {topMatches.map(o => (
                    <OntologyCardFor
                        key={o.id}
                        ontology={o}
                        match={scoreOf.get(o.id)}
                        selected={selectedId === o.id}
                        isBest={bestId === o.id && matching.phase === 'ready'}
                        analysed={matching.phase === 'ready'}
                        onPick={() => onPick(o.id)}
                    />
                ))}

                {/* Chosen from the long list, then collapsed — keep it on screen
                    rather than making the selection vanish. */}
                {selectedIsHidden && (() => {
                    const o = restMatches.find(x => x.id === selectedId)!
                    return (
                        <OntologyCardFor
                            ontology={o}
                            match={scoreOf.get(o.id)}
                            selected
                            analysed={matching.phase === 'ready'}
                            onPick={() => onPick(o.id)}
                        />
                    )
                })()}

                {showAll && pagedRest.map(o => (
                    <OntologyCardFor
                        key={o.id}
                        ontology={o}
                        match={scoreOf.get(o.id)}
                        selected={selectedId === o.id}
                        analysed={matching.phase === 'ready'}
                        onPick={() => onPick(o.id)}
                    />
                ))}
            </div>

            {restMatches.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                    <button
                        type="button"
                        onClick={() => { setShowAll(v => !v); setPage(0) }}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showAll && 'rotate-180')} />
                        {showAll
                            ? 'Show only the top matches'
                            : `Show all ${rankedOntologies.length} semantic layers`}
                    </button>

                    {showAll && pageCount > 1 && (
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                disabled={page === 0}
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-slate-500 tabular-nums px-1">
                                {page + 1} / {pageCount}
                            </span>
                            <button
                                type="button"
                                disabled={page >= pageCount - 1}
                                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </>
    )
}

/**
 * One place that turns an ontology + its match into a card.
 *
 * The top three and the expanded list render through this, so a layer cannot show
 * a coverage ring in one place and a bare name in the other. That equivalence is
 * the point: a layer is only fairly rejected if you can see the same numbers and
 * warnings that got the winners to the top.
 */
function OntologyCardFor({ ontology, match, selected, isBest, analysed, onPick }: {
    ontology: OntologyDefinitionResponse
    match?: OntologyMatchResult
    selected: boolean
    isBest?: boolean
    analysed: boolean
    onPick: () => void
}) {
    return (
        <OntologyCard
            selected={selected}
            onClick={onPick}
            title={ontology.name}
            subtitle={ontology.description || `Version ${ontology.version}`}
            meta={`${Object.keys(ontology.entityTypeDefinitions ?? {}).length} entity types · ${Object.keys(ontology.relationshipTypeDefinitions ?? {}).length} relationships`}
            published={ontology.isPublished}
            // A zero-overlap layer scores 0 and covers nothing: showing it an empty
            // ring and a "doesn't cover: <everything>" list is noise. It reads as
            // what it is.
            match={match && match.jaccardScore > 0 ? match : undefined}
            isBest={isBest}
            noOverlap={analysed && (!match || match.jaccardScore === 0)}
        />
    )
}

function OntologyCard({ selected, onClick, title, subtitle, meta, published, dashed, match, isBest, noOverlap }: {
    selected: boolean
    onClick: () => void
    title: string
    subtitle: string
    meta: string
    published?: boolean
    dashed?: boolean
    /** Absent until the graph has been profiled — the card degrades to plain. */
    match?: OntologyMatchResult
    isBest?: boolean
    /** Analysed, and it doesn't overlap this graph (the server drops <10%). */
    noOverlap?: boolean
}) {
    // The SAME percentage the onboarding wizard shows: how much of the graph's
    // vocabulary — entity types AND relationship types — this layer accounts for.
    // Jaccard is what ranks them; coverage is what the human reads.
    const entityTotal = match
        ? match.coveredEntityTypes.length + match.uncoveredEntityTypes.length
        : 0
    const relTotal = match
        ? match.coveredRelationshipTypes.length + match.uncoveredRelationshipTypes.length
        : 0
    const totalAll = entityTotal + relTotal
    const totalCovered = match
        ? match.coveredEntityTypes.length + match.coveredRelationshipTypes.length
        : 0
    const pct = match && totalAll > 0 ? Math.round((totalCovered / totalAll) * 100) : 0
    return (
        <motion.button
            type="button"
            onClick={onClick}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            className={cn(
                'relative flex flex-col gap-1 p-4 rounded-xl border-2 text-left transition-colors',
                dashed && 'border-dashed',
                selected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-4 ring-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700',
                // Still selectable — the score is advice, not a gate — but it stops
                // competing with the layers that actually fit.
                noOverlap && !selected && 'opacity-60',
            )}
        >
            <span className="flex items-start gap-3 min-w-0">
                {/* The score, where the eye lands first. Without it these cards are
                    eight identical names. */}
                {match && (
                    <CoverageRing percent={pct} size={44} stroke={4} color={coverageColor(pct)} />
                )}

                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                        {!match && (dashed
                            ? <Sparkles className="w-4 h-4 text-slate-400 shrink-0" />
                            : <BookOpen className="w-4 h-4 text-slate-400 shrink-0" />)}
                        <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{title}</span>
                        {isBest && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400">
                                BEST FIT
                            </span>
                        )}
                        {published === false && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400">
                                DRAFT
                            </span>
                        )}
                    </span>

                    {match ? (
                        <span className="block mt-1.5 space-y-1">
                            <MiniBar
                                covered={match.coveredEntityTypes.length}
                                total={entityTotal}
                                label="Entity types"
                                colorClass={coverageBarClass(entityTotal > 0
                                    ? Math.round((match.coveredEntityTypes.length / entityTotal) * 100)
                                    : 0)}
                            />
                            <MiniBar
                                covered={match.coveredRelationshipTypes.length}
                                total={relTotal}
                                label="Relationships"
                                colorClass={coverageBarClass(relTotal > 0
                                    ? Math.round((match.coveredRelationshipTypes.length / relTotal) * 100)
                                    : 0)}
                            />
                            {/* What it MISSES. A 60% match sounds fine until you see
                                which of your types it can't name. */}
                            {match.uncoveredEntityTypes.length > 0 && (
                                <span className="block text-[10px] text-amber-600 dark:text-amber-400 truncate">
                                    Doesn't cover: {match.uncoveredEntityTypes.slice(0, 3).join(', ')}
                                    {match.uncoveredEntityTypes.length > 3 && ` +${match.uncoveredEntityTypes.length - 3}`}
                                </span>
                            )}
                        </span>
                    ) : (
                        <>
                            <span className="block text-xs text-slate-500 truncate">{subtitle}</span>
                            <span className="block text-[11px] text-slate-400 truncate">{meta}</span>
                            {noOverlap && (
                                <span className="block text-[10px] text-slate-400 mt-1">
                                    No overlap with this graph's types
                                </span>
                            )}
                        </>
                    )}
                </span>
            </span>

            {selected && (
                <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"
                >
                    <Check className="w-3 h-3 text-white" />
                </motion.span>
            )}
        </motion.button>
    )
}
