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
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { AncestorRef } from '@/types/search'


export function resolveHitLayer(
    hit: { urn: string; entityType: string },
    ancestorPath: ReadonlyArray<AncestorRef>,
    assignments: Record<string, LayerAssignmentEntry>,
    layers: ViewLayerConfig[],
): string | null {
    const chain = [...ancestorPath, hit]
    for (let i = 0; i < chain.length; i++) {
        const isHit = i === chain.length - 1
        const entry = assignments[chain[i].urn]
        if (!entry) continue
        if (!isHit && entry.inheritsChildren === false) continue
        return entry.layerId
    }

    if (Object.keys(assignments).length > 0) return null

    const topLevel = ancestorPath[0] ?? hit
    const fallback = layers.find((l) => l.entityTypes.includes(topLevel.entityType))
    return fallback ? fallback.id : null
}
