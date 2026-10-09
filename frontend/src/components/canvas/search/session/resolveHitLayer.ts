/**
 * Picks which layer column a search hit badges under, for the panel's
 * layer › container grouping (``groupHitsByLayer``).
 *
 * Walks ``[...ancestorPath, hit]`` from the root: the first URN that
 * has an assignment entry wins, EXCEPT an ancestor (not the hit itself)
 * whose entry has ``inheritsChildren === false`` — that entry only
 * places the ancestor, not its descendants, so it's skipped and the
 * walk continues toward the hit.
 *
 * When nothing in the chain matches:
 *   - a curated view (``assignments`` non-empty) resolves to ``null``
 *     — the hit renders in the panel's "Not on this canvas" group.
 *   - an open view (``assignments`` empty) falls back to the layer
 *     whose ``entityTypes`` includes the TOP-LEVEL node's type (the
 *     root of ``ancestorPath``, or the hit itself when it has no
 *     ancestors).
 */
import {
    factsFromGraphNode,
    parentContextOf,
    place,
    type CompiledPlacementSpec,
    type ParentContext,
} from '@/lib/placement/placement'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { AncestorRef } from '@/types/search'


/**
 * @param hasAssignments - whether ``assignments`` has any entry, which is
 *   what tells a curated view from an open one. Derived here when the
 *   caller doesn't say, but a caller resolving a whole result page should:
 *   this is the only O(assignments) step in an otherwise O(path) walk, and
 *   at a thousand hits over a five-thousand-entry map it is the whole cost
 *   of the grouping.
 */
export function resolveHitLayer(
    hit: { urn: string; entityType: string },
    ancestorPath: ReadonlyArray<AncestorRef>,
    assignments: Record<string, LayerAssignmentEntry>,
    layers: ViewLayerConfig[],
    hasAssignments: boolean = Object.keys(assignments).length > 0,
): string | null {
    const chain = [...ancestorPath, hit]
    for (let i = 0; i < chain.length; i++) {
        const isHit = i === chain.length - 1
        const entry = assignments[chain[i].urn]
        if (!entry) continue
        if (!isHit && entry.inheritsChildren === false) continue
        return entry.layerId
    }

    if (hasAssignments) return null

    const topLevel = ancestorPath[0] ?? hit
    const fallback = layers.find((l) => l.entityTypes.includes(topLevel.entityType))
    return fallback ? fallback.id : null
}


/**
 * Flag-on (One Placement Contract): the hit's column, as the canvas would
 * place it. ``ancestorPath`` (root first) is its parent chain, so the
 * NEAREST entry wins and the view's own scope decides. Ancestors carry only
 * urn, type and name, so a tag or property rule or a stamp on an ANCESTOR
 * is not seen; the hit's own facts are complete. A fallback counts: the hit
 * is drawn in that column.
 */
export function placeHit(
    hit: GraphNode,
    ancestorPath: ReadonlyArray<AncestorRef>,
    spec: CompiledPlacementSpec,
): string | null {
    let parents: ParentContext[] = []
    for (const a of ancestorPath) {
        const facts = factsFromGraphNode({ urn: a.urn, entityType: a.entityType, displayName: a.displayName, properties: {} })
        const context = parentContextOf(a.urn, place(spec, a.urn, facts, parents))
        parents = context ? [context] : []
    }
    return place(spec, hit.urn, factsFromGraphNode(hit), parents).layerId
}
