/**
 * The edges a page of rows brings, at what the PAGE costs — never what is loaded. Shared by
 * a column's next page (useGraphHydration.loadMoreFeeds) and entities loaded by where the view
 * draws them (features/served-placement/loadIntoCanvas).
 */
import type { EntityTypeDefinition, GraphDataProvider, GraphEdge } from '@/providers/GraphDataProvider'
import { useCanvasStore } from '@/store/canvas'
import { isContainmentEdgeType, normalizeEdgeType } from '@/store/schema'

/** The view's lineage types less the stored :AGGREGATED cells: the rows on
 *  screen get their roll-ups from /edges/aggregated, never from a read of
 *  their flows. */
export function lineageOnly(lineageEdgeTypes: string[]): string[] {
    return lineageEdgeTypes.filter(t => t.toUpperCase() !== 'AGGREGATED')
}

/** A stored roll-up cell, which an untyped read can still bring. */
export function isAggregatedEdge(e: GraphEdge): boolean {
    return String(e.edgeType ?? '').toUpperCase() === 'AGGREGATED'
}

export interface PageEdgeTypes {
    /** The page's entity types: containment to loaded orphans of a type they can contain is read too. */
    entityTypes: string[]
    schemaEntityTypes: EntityTypeDefinition[]
    containmentEdgeTypes: string[]
    lineageEdgeTypes: string[]
}

/** A page's edges: its incoming containment, lineage touching it, and containment
 *  to loaded orphans of a type ``entityTypes`` can contain — each kept once both
 *  ends are loaded. Null: a new graph was set meanwhile (``stale``). */
export async function edgesForPage(
    provider: Pick<GraphDataProvider, 'getEdges' | 'getEdgesBetween'>,
    pageUrns: string[],
    types: PageEdgeTypes,
    stale: () => boolean,
): Promise<GraphEdge[] | null> {
    const { entityTypes, schemaEntityTypes, containmentEdgeTypes, lineageEdgeTypes } = types
    const before = useCanvasStore.getState()
    const childTypes = new Set(entityTypes.flatMap(t =>
        schemaEntityTypes.find(e => e.id === t)?.hierarchy?.canContain ?? []))
    let orphans: string[] = []
    if (childTypes.size > 0 && containmentEdgeTypes.length > 0) {
        const parented = new Set<string>()
        for (const e of before.edges) {
            if (isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) parented.add(e.target)
        }
        orphans = before.nodes
            .filter(n => childTypes.has(n.data.type) && !parented.has(n.id))
            .map(n => n.id)
    }
    const noteFailure = (err: unknown): GraphEdge[] => {
        useCanvasStore.getState().noteEdgeFetchFailure(err instanceof Error ? err.message : undefined)
        return []
    }
    // Lineage out of and into the page as two ANCHORED reads: the
    // one-query `anyUrns` form has no index-friendly shape and scans
    // every lineage edge of the graph for each page. Flows only,
    // never the stored :AGGREGATED cells, as /edges/between.
    const none = Promise.resolve([] as GraphEdge[])
    const lineage = lineageOnly(lineageEdgeTypes)
    const [incoming, lineageOut, lineageIn, adopted] = pageUrns.length === 0 ? [[], [], [], []] : await Promise.all([
        containmentEdgeTypes.length > 0
            ? provider.getEdges({ targetUrns: pageUrns, edgeTypes: containmentEdgeTypes, limit: pageUrns.length * 4 + 100 }).catch(noteFailure)
            : none,
        lineage.length > 0
            ? provider.getEdges({ sourceUrns: pageUrns, edgeTypes: lineage, limit: 200_000 }).catch(noteFailure)
            : none,
        lineage.length > 0
            ? provider.getEdges({ targetUrns: pageUrns, edgeTypes: lineage, limit: 200_000 }).catch(noteFailure)
            : none,
        orphans.length > 0
            ? provider.getEdgesBetween([...pageUrns, ...orphans], containmentEdgeTypes).catch(noteFailure)
            : none,
    ])
    if (stale()) return null
    const held = useCanvasStore.getState()._nodeIndex
    const onPage = new Set(pageUrns)
    const isLoaded = (u: string) => held.has(u) || onPage.has(u)
    return [...incoming, ...lineageOut, ...lineageIn, ...adopted]
        .filter(e => !isAggregatedEdge(e) && isLoaded(e.sourceUrn) && isLoaded(e.targetUrn))
}
