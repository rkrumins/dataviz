/**
 * The canvas's input to the One Placement Contract (lib/placement), flag-on.
 *
 * Facts come from each loaded node's data. Parents are every LOADED containment parent: the
 * hierarchy's own (parentMap) plus any other parent childMap lists for a node held by several.
 * A node with no loaded parent climbs its fetched chain (usePlacementChains) — or, before that
 * lands, its direct parent — through ancestors the canvas has not loaded, which have no facts.
 * That is enough for a hand placement above it to cascade, and never enough to guess a rule or a
 * stamp the canvas cannot see.
 */
import {
  factsFromCanvasData,
  placeAll,
  type CompiledPlacementSpec,
  type ExplicitEntry,
  type PlacementResult,
} from '@/lib/placement/placement'

const NO_PARENTS: readonly string[] = []

export function placeCanvasNodes(i: {
  spec: CompiledPlacementSpec
  nodes: ReadonlyArray<{ id: string }>
  nodeMap: ReadonlyMap<string, { data?: Record<string, unknown> }>
  parentMap: ReadonlyMap<string, string>
  childMap: ReadonlyMap<string, readonly string[]>
  /** urn → its ancestors, parent first, root last. */
  chains: ReadonlyMap<string, readonly string[]>
  createdInBranch: ReadonlySet<string>
}): Map<string, PlacementResult> {
  const { spec, nodes, nodeMap, parentMap, childMap, chains, createdInBranch } = i
  // A node held by several parents: the ones parentMap does not name.
  const others = new Map<string, string[]>()
  childMap.forEach((children, parent) => {
    for (const child of children) {
      if (parentMap.get(child) === parent) continue
      const list = others.get(child)
      if (list) list.push(parent)
      else others.set(child, [parent])
    }
  })

  const parents = new Map<string, string[]>()
  const link = (child: string, parent: string) => {
    const list = parents.get(child)
    if (list) list.push(parent)
    else parents.set(child, [parent])
  }
  const virtual = new Set<string>()
  for (const { id } of nodes) {
    const primary = parentMap.get(id)
    if (primary !== undefined && nodeMap.has(primary)) link(id, primary)
    for (const p of others.get(id) ?? NO_PARENTS) if (nodeMap.has(p)) link(id, p)
    if (parents.has(id)) continue
    // No loaded parent: climb through the unloaded ancestors to the first loaded one, whose own
    // parents apply from there.
    let below = id
    for (const up of chains.get(id) ?? (primary !== undefined ? [primary] : NO_PARENTS)) {
      link(below, up)
      if (nodeMap.has(up)) break
      virtual.add(up)
      below = up
    }
  }

  return placeAll(
    spec,
    [...nodes.map(n => n.id), ...virtual],
    u => (nodeMap.has(u) ? factsFromCanvasData(nodeMap.get(u)!.data, u) : null),
    u => parents.get(u) ?? NO_PARENTS,
    createdInBranch,
  )
}

/** The session's drags as explicit entries over the view's own — only onto a layer the view still
 *  has, and cascading as the view's entry for that entity says. */
export function withSessionPlacements(
  spec: CompiledPlacementSpec,
  instance: ReadonlyMap<string, { layerId: string }>,
): CompiledPlacementSpec {
  if (instance.size === 0) return spec
  const explicit = new Map<string, ExplicitEntry>(spec.explicit)
  instance.forEach((a, urn) => {
    if (spec.layerIds.has(a.layerId)) {
      explicit.set(urn, { layerId: a.layerId, inheritsChildren: spec.explicit.get(urn)?.inheritsChildren ?? true })
    }
  })
  return {
    ...spec,
    explicit,
    hasCascadingExplicit: [...explicit.values()].some(e => e.inheritsChildren && spec.layerIds.has(e.layerId)),
  }
}
