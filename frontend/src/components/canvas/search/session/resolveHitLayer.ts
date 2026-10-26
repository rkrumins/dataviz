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
 *   - a curated view (one that holds only what it places) resolves to
 *     ``null`` — the hit renders in the panel's "Not on this canvas" group.
 *   - an open view falls back to the layer whose ``entityTypes`` includes
 *     the TOP-LEVEL node's type (the root of ``ancestorPath``, or the hit
 *     itself when it has no ancestors).
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
 * @param curated - whether the view holds only what it places
 *   (``deriveEntityScope``): a view set to hold every entity of its types
 *   is open, whatever it places by hand. Unsaid, any assignment makes it
 *   curated, as ``deriveEntityScope`` reads a view that doesn't say — but a
 *   caller resolving a whole result page should say: this is the only
 *   O(assignments) step in an otherwise O(path) walk, and at a thousand hits
 *   over a five-thousand-entry map it is the whole cost of the grouping.
 */
export function resolveHitLayer(
    hit: { urn: string; entityType: string },
    ancestorPath: ReadonlyArray<AncestorRef>,
    assignments: Record<string, LayerAssignmentEntry>,
    layers: ViewLayerConfig[],
    curated: boolean = Object.keys(assignments).length > 0,
): string | null {
    const chain = [...ancestorPath, hit]
    for (let i = 0; i < chain.length; i++) {
        const isHit = i === chain.length - 1
        const entry = assignments[chain[i].urn]
        if (!entry) continue
        if (!isHit && entry.inheritsChildren === false) continue
        return entry.layerId
    }

    if (curated) return null

    const topLevel = ancestorPath[0] ?? hit
    // A layer saved without its types (written through the API) claims none.
    const fallback = layers.find((l) => (l.entityTypes ?? []).includes(topLevel.entityType))
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
