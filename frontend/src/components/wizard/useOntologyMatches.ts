/**
 * useOntologyMatches — "which semantic layer actually fits this graph?"
 *
 * The Add/Move Data Source wizard was asking the user to choose a semantic layer
 * from a flat list of every ontology in the system. In this instance that's eight
 * cards all called "Roots-node", identical apart from an invisible id.
 * There is no way to answer that question by reading it.
 *
 * The onboarding wizard already answers it: profile the graph, ask the server which
 * ontologies cover its entity types, and rank by Jaccard overlap. Same inputs are
 * available here (a catalog item knows its provider and its source identifier), so
 * this runs the same pipeline:
 *
 *   getAssetStats(provider, asset)  →  transformStatsForSuggest  →  POST /suggest
 *
 * Extracted rather than copied so the two wizards can't drift into recommending
 * different layers for the same graph.
 *
 * COLD CACHE IS A REAL STATE, NOT AN ERROR. Asset stats are computed in the
 * background; on a cold cache the envelope carries `status: 'computing'` and no
 * data. That's retriable, and it's reported as such — silently showing "no match"
 * would tell the user their graph fits nothing, which is a different and false
 * claim.
 */
import { useCallback, useEffect, useState } from 'react'
import { providerService } from '@/services/providerService'
import {
    ontologyDefinitionService,
    type OntologyMatchResult,
    type OntologySuggestResponse,
} from '@/services/ontologyDefinitionService'

/** Raw provider stats → the shape POST /ontologies/suggest expects. */
function transformStatsForSuggest(raw: {
    nodeCount?: number
    edgeCount?: number
    entityTypeCounts?: Record<string, number>
    edgeTypeCounts?: Record<string, number>
}): Record<string, unknown> {
    return {
        totalNodes: raw.nodeCount ?? 0,
        totalEdges: raw.edgeCount ?? 0,
        entityTypeStats: Object.entries(raw.entityTypeCounts ?? {}).map(
            ([name, count]) => ({ id: name, name, count, sampleNames: [] }),
        ),
        edgeTypeStats: Object.entries(raw.edgeTypeCounts ?? {}).map(
            ([name, count]) => ({ id: name, name, count, sourceTypes: [], targetTypes: [] }),
        ),
        tagStats: [],
    }
}

export interface OntologyMatchState {
    phase: 'idle' | 'analyzing' | 'ready' | 'error'
    matches: OntologyMatchResult[]
    response: OntologySuggestResponse | null
    /** What the graph actually contains — the denominator behind every percentage. */
    graphCounts: { entities: number; rels: number }
    /** Highest-scoring ontology, or null when nothing overlaps at all. */
    best: OntologyMatchResult | null
    error: string | null
    /** True when the failure is "stats aren't computed yet" — worth retrying. */
    retriable: boolean
    analyze: () => void
}

export function useOntologyMatches({ providerId, assetName, enabled }: {
    providerId?: string
    /** The graph name as the provider knows it (sourceIdentifier), not the label. */
    assetName?: string
    enabled: boolean
}): OntologyMatchState {
    const [phase, setPhase] = useState<OntologyMatchState['phase']>('idle')
    const [matches, setMatches] = useState<OntologyMatchResult[]>([])
    const [response, setResponse] = useState<OntologySuggestResponse | null>(null)
    const [graphCounts, setCounts] = useState({ entities: 0, rels: 0 })
    const [error, setError] = useState<string | null>(null)
    const [retriable, setRetriable] = useState(false)

    const analyze = useCallback(async () => {
        if (!providerId || !assetName) return

        setPhase('analyzing')
        setError(null)
        setRetriable(false)

        try {
            const envelope = await providerService.getAssetStats(providerId, assetName)

            if (!envelope.data) {
                const computing = envelope.meta.status === 'computing'
                setRetriable(true)
                throw new Error(
                    computing
                        ? "We're still profiling this graph. Try again in a few seconds."
                        : 'This graph has no profile yet, so we can\'t score the semantic layers.',
                )
            }

            const stats = transformStatsForSuggest(envelope.data)
            const suggested = await ontologyDefinitionService.suggest(stats)

            // Rank by overlap. Ties keep the server's order, which is stable.
            const ranked = [...suggested.matchingOntologies]
                .sort((a, b) => b.jaccardScore - a.jaccardScore)

            setMatches(ranked)
            setResponse(suggested)
            setCounts({
                entities: (stats.entityTypeStats as unknown[]).length,
                rels: (stats.edgeTypeStats as unknown[]).length,
            })
            setPhase('ready')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not analyse the graph.')
            setPhase('error')
        }
    }, [providerId, assetName])

    // Analyse once the step is reachable and we know which graph to look at.
    useEffect(() => {
        if (!enabled || !providerId || !assetName) return
        if (phase !== 'idle') return
        void analyze()
    }, [enabled, providerId, assetName, phase, analyze])

    // A different source means a different graph — throw the old scores away rather
    // than showing yesterday's match against today's data.
    useEffect(() => {
        setPhase('idle')
        setMatches([])
        setResponse(null)
        setError(null)
    }, [providerId, assetName])

    return {
        phase,
        matches,
        response,
        graphCounts,
        best: matches[0] ?? null,
        error,
        retriable,
        analyze,
    }
}
