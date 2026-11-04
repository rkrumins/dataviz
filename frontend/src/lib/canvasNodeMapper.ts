/**
 * Pure backend→canvas mappers, extracted from useGraphHydration so callers
 * that only need the mapping (e.g. useStageEntityCreation's node swap on
 * save) don't inherit the hydration hook's heavy transitive imports
 * (GraphProviderContext → workspaces → app bootstrap), which also crash
 * jsdom test environments at module load.
 */
import type { GraphNode, GraphEdge } from '@/providers/GraphDataProvider'
import type { LineageNode, LineageEdge } from '@/store/canvas'

/** ``n`` as the feed of a subset view's layer ``layerId`` listed it: its row is drawn in
 *  that layer, where the server placed it (as the view's base places it, or by type). */
export function withFeedLayer(n: GraphNode, layerId: string): GraphNode {
    return { ...n, feedLayerId: layerId } as GraphNode
}

/** Convert a backend GraphNode to a canvas LineageNode — every field verbatim. A node
 *  a subset view's feed lists carries where it sits (`ancestorPath`, root first): its
 *  containers, named and never loaded; how many of the nearest share its layer
 *  (`inLayer`), which the canvas draws it inside; and the layer whose feed listed it
 *  (`withFeedLayer`). */
export function toCanvasNode(n: GraphNode, opts?: { randomPosition?: boolean }): LineageNode {
    const path = (n as { ancestorPath?: Array<{ urn: string; displayName?: string; entityType?: string }> }).ancestorPath
    const inLayer = (n as { inLayer?: number }).inLayer
    const feedLayerId = (n as { feedLayerId?: string }).feedLayerId
    return {
        id: n.urn,
        type: 'generic' as const,
        position: opts?.randomPosition
            ? { x: Math.random() * 800, y: Math.random() * 600 }
            : { x: 0, y: 0 },
        data: {
            // Identity
            urn: n.urn,
            label: n.displayName,
            type: n.entityType,
            // Descriptive — verbatim from the backend GraphNode
            qualifiedName: n.qualifiedName,
            description: n.description,
            sourceSystem: n.sourceSystem,
            layerAssignment: n.layerAssignment,
            lastSyncedAt: n.lastSyncedAt,
            childCount: n.childCount,
            // Editable property bag (renamed from `metadata` → `properties`)
            properties: n.properties,
            // OCC token (content hash) the node was read at — echoed as baseVersion on an edit.
            version: n.version,
            // Frontend conveniences derived from the property bag / tags
            classifications: n.tags,
            businessLabel: (n.properties?.businessLabel as string) ?? undefined,
            ...(path && path.length > 0 ? { ancestorPath: path.map(a => (
                { urn: a.urn, displayName: a.displayName || a.urn, entityType: a.entityType })) } : {}),
            ...(inLayer ? { inLayer } : {}),
            ...(feedLayerId ? { feedLayerId } : {}),
        },
    }
}

/** Convert a backend GraphEdge to a canvas LineageEdge using real backend edge data. */
export function toCanvasEdge(e: GraphEdge): LineageEdge {
    // `properties` was dropped wholesale, which quietly cost every
    // rolled-up edge its identity: a materialized AGGREGATED edge arrived
    // looking like one plain connection, so it showed no ×N badge and
    // offered no drill. Carry the two facts the UI actually reads.
    // `isAggregated` / `sourceEdgeCount` are client-only — both
    // stagedChangesToOps and EdgeDetailPanel strip them before any write.
    const props = e.properties ?? {}
    const rolledUp = Array.isArray(props.sourceEdgeTypes)
    const weight = typeof props.weight === 'number' && props.weight > 1 ? props.weight : undefined
    return {
        id: e.id,
        source: e.sourceUrn,
        target: e.targetUrn,
        type: 'lineage',
        data: {
            edgeType: e.edgeType,
            relationship: e.edgeType,
            confidence: e.confidence,
            version: e.version,   // OCC token — echoed as baseVersion on an edit
            ...(rolledUp ? { isAggregated: true } : {}),
            ...(weight !== undefined ? { sourceEdgeCount: weight } : {}),
        },
    }
}
