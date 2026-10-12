/**
 * Placement vs. the data. A view may PLACE an entity in a layer (or group) apart from its parent —
 * App A shown in Layer 2 while, in the data, it sits inside My Data Domain. That is view
 * arrangement only; the data is unchanged. Each such entity carries its full path in the data, so
 * the canvas can say so instead of looking like a stray duplicate.
 */
import type { AncestorRef } from '@/types/search'

export interface PlacementInfo {
  /** The entity's ancestors in the data, root first, ending with its parent. */
  path: AncestorRef[]
  /** False while the part above the loaded ancestors is not known yet (shown as "…"). */
  complete: boolean
  /** The column its parent is shown in, and the one it is placed in. */
  parentLayerName: string
  placedLayerName: string
}

/** A parent whose children are placed in other columns: which, and where. */
export interface PlacedOut {
  children: string[]
  layerNames: string[]
}

interface NodeFacts { name: string; type: string }

/**
 * Every entity drawn in a different column than its parent, with its path. `ancestry` holds, per
 * highest LOADED ancestor, the ancestors above it (root first; [] = a root). Also returns the
 * highest loaded ancestors whose ancestry is not known yet, for the caller to ask about.
 */
export function buildPlacements(args: {
  parentMap: ReadonlyMap<string, string>
  nodeLayerMap: ReadonlyMap<string, string>
  facts: (id: string) => NodeFacts | undefined
  layerName: (id: string) => string
  /** The group (view-only container) an entity is drawn in, if any. */
  groupOf?: (id: string) => { id: string; name: string } | undefined
  ancestry: ReadonlyMap<string, readonly AncestorRef[]>
}): { placements: Map<string, PlacementInfo>; placedOut: Map<string, PlacedOut>; unknownTops: string[] } {
  const { parentMap, nodeLayerMap, facts, layerName, groupOf, ancestry } = args
  const placements = new Map<string, PlacementInfo>()
  const placedOut = new Map<string, PlacedOut>()
  const unknownTops = new Set<string>()
  for (const [child, parent] of parentMap) {
    const own = nodeLayerMap.get(child)
    const theirs = nodeLayerMap.get(parent)
    if (!own || !theirs) continue
    // Apart from its parent: in another column, or in a group its parent is not in.
    const group = groupOf?.(child)
    const inOtherGroup = !!group && group.id !== groupOf?.(parent)?.id
    if (own === theirs && !inOtherGroup) continue
    const placedIn = inOtherGroup ? `${group!.name} (${layerName(own)})` : layerName(own)
    const loaded: AncestorRef[] = []
    const seen = new Set<string>()
    let at: string | undefined = parent
    let top = parent
    while (at && !seen.has(at)) {
      seen.add(at)
      const f = facts(at)
      loaded.unshift({ urn: at, displayName: f?.name ?? at, entityType: f?.type ?? '' } as AncestorRef)
      top = at
      at = parentMap.get(at)
    }
    const above = ancestry.get(top)
    if (!above) unknownTops.add(top)
    const out = placedOut.get(parent) ?? { children: [], layerNames: [] }
    out.children.push(facts(child)?.name ?? child)
    if (!out.layerNames.includes(placedIn)) out.layerNames.push(placedIn)
    placedOut.set(parent, out)
    placements.set(child, {
      path: [...(above ?? []), ...loaded],
      complete: above !== undefined,
      parentLayerName: layerName(theirs),
      placedLayerName: placedIn,
    })
  }
  return { placements, placedOut, unknownTops: [...unknownTops] }
}
