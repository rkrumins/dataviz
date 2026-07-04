/**
 * planDuplicate — pure planner for the "Duplicate" subtree recreation.
 *
 * Computes an ordered, deterministic plan of node/edge staging steps for
 * copying an entity and its entire descendant subtree. Has no React/store
 * dependencies so it can be unit-tested without mocking Zustand stores or a
 * graph provider — see useDuplicateSubtree.ts for the hook that loads the
 * live subtree from the canvas store and executes this plan via
 * stageEntity/staged create_edge.
 */

export interface DuplicateSourceNode {
  /** The original entity's own urn — stamped onto its copy as `duplicatedFrom` provenance. */
  urn: string
  entityType: string
  displayName: string
  tags?: string[]
  properties?: Record<string, unknown>
  /**
   * The containment edge type connecting this node's ORIGINAL parent to this
   * node (undefined when the node has no containment parent, e.g. a
   * top-level root). Reused on the corresponding parentCopy→copy edge for
   * ontology fidelity.
   */
  containmentEdgeType?: string
}

export interface DuplicateLineageEdgeInput {
  /** Original node id of the edge's source. */
  source: string
  /** Original node id of the edge's target. */
  target: string
  edgeType: string
}

export interface DuplicateNodeStep {
  /** The original node's id this step copies. */
  originalId: string
  originalUrn: string
  entityType: string
  /** "{name} (Copy)" for the root step; the original name, verbatim, for descendants. */
  displayName: string
  tags: string[]
  /** Original properties plus `duplicatedFrom` provenance (that node's OWN original urn). */
  properties: Record<string, unknown>
  /**
   * originalId of this step's parent step WITHIN the plan, or null for the
   * root step — the root copy's real parent is OUTSIDE the subtree (it's
   * placed as a sibling of the original), so the caller supplies that
   * parent urn separately.
   */
  parentOriginalId: string | null
  containmentEdgeType?: string
}

export interface DuplicateEdgeStep {
  sourceOriginalId: string
  targetOriginalId: string
  edgeType: string
}

export interface PlanDuplicateResult {
  nodes: DuplicateNodeStep[]
  edges: DuplicateEdgeStep[]
}

/**
 * Plan a subtree duplication, top-down (root first, each child immediately
 * after its parent) so the caller can stage in order and thread newly-staged
 * urns via `parentOriginalId`.
 *
 * @param rootId      The original subtree root's node id.
 * @param childMap    parentId → childIds (containment only), covering the
 *                    full, already-loaded subtree.
 * @param nodeData    Original entity data for every id in the subtree (root +
 *                    all descendants), keyed by node id.
 * @param lineageEdges Candidate non-containment edges touching the subtree —
 *                    MAY include cross-boundary edges (one endpoint outside
 *                    the subtree). This function decides internal vs.
 *                    cross-boundary and only plans the former.
 */
export function planDuplicate(
  rootId: string,
  childMap: Map<string, string[]>,
  nodeData: Map<string, DuplicateSourceNode>,
  lineageEdges: DuplicateLineageEdgeInput[],
): PlanDuplicateResult {
  const nodes: DuplicateNodeStep[] = []
  const subtreeIds = new Set<string>()
  const visited = new Set<string>()

  const visit = (id: string, parentOriginalId: string | null, isRoot: boolean) => {
    if (visited.has(id)) return // cycle guard — containment should never cycle, but don't hang if it does
    visited.add(id)
    const source = nodeData.get(id)
    if (!source) return // no data for this id — can't plan a copy without it

    subtreeIds.add(id)
    nodes.push({
      originalId: id,
      originalUrn: source.urn,
      entityType: source.entityType,
      displayName: isRoot ? `${source.displayName} (Copy)` : source.displayName,
      tags: source.tags ?? [],
      properties: { ...(source.properties ?? {}), duplicatedFrom: source.urn },
      parentOriginalId,
      containmentEdgeType: source.containmentEdgeType,
    })

    for (const childId of childMap.get(id) ?? []) {
      visit(childId, id, false)
    }
  }

  visit(rootId, null, true)

  const edges: DuplicateEdgeStep[] = []
  for (const e of lineageEdges) {
    if (subtreeIds.has(e.source) && subtreeIds.has(e.target)) {
      edges.push({ sourceOriginalId: e.source, targetOriginalId: e.target, edgeType: e.edgeType })
    }
  }

  return { nodes, edges }
}
