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
   * The entity's description — a node field. The plan carries it in the step's
   * properties (one bag to snapshot); the staging hook lifts it back out into
   * the node field, where the server keeps it (useDuplicateSubtree).
   */
  description?: string
  /**
   * The containment edge type connecting this node's ORIGINAL parent to this
   * node (undefined when the node has no containment parent, e.g. a
   * top-level root). Reused on the corresponding parentCopy→copy edge for
   * ontology fidelity.
   */
  containmentEdgeType?: string
  /** The system it comes from — the copy describes the same thing. (Its
   *  qualified name is an identifier, and is deliberately not copied.) */
  sourceSystem?: string
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
  sourceSystem?: string
}

export interface DuplicateEdgeStep {
  sourceOriginalId: string
  targetOriginalId: string
  edgeType: string
  /**
   * A BOUNDARY edge: this end stays the original entity outside the copy, so
   * the copy gains the same partner — `source` for an incoming edge (the
   * original's source feeds the copy too), `target` for an outgoing one (the
   * copy feeds what the original feeds). Absent for an edge inside the copy,
   * whose both ends are copies.
   */
  keeps?: 'source' | 'target'
}

/** What a duplicate copies besides the entity itself. */
export interface PlanDuplicateOptions {
  /** Everything inside the entity too (the default), or the entity alone. */
  includeDescendants?: boolean
  /** Edges with both ends in the copy (the default). */
  internal?: boolean
  /** Edges into the copy from outside it: the original's sources feed the copy too. */
  incoming?: boolean
  /** Edges out of the copy: the copy feeds what the original feeds. */
  outgoing?: boolean
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
  options: PlanDuplicateOptions = {},
): PlanDuplicateResult {
  const { includeDescendants = true, internal = true, incoming = false, outgoing = false } = options
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
      properties: {
        ...(source.properties ?? {}),
        // Top-level description wins over any stale properties.description; the
        // backend persists it from properties.description on create.
        ...(source.description != null ? { description: source.description } : {}),
        duplicatedFrom: source.urn,
      },
      parentOriginalId,
      containmentEdgeType: source.containmentEdgeType,
      ...(source.sourceSystem ? { sourceSystem: source.sourceSystem } : {}),
    })

    if (!includeDescendants) return
    for (const childId of childMap.get(id) ?? []) {
      visit(childId, id, false)
    }
  }

  visit(rootId, null, true)

  // The same edge can arrive twice (loaded on the canvas AND read from the
  // server); it is planned once.
  const seen = new Set<string>()
  const edges: DuplicateEdgeStep[] = []
  for (const e of lineageEdges) {
    const key = `${e.source}\u0000${e.target}\u0000${e.edgeType.toUpperCase()}`
    if (seen.has(key)) continue
    const inSource = subtreeIds.has(e.source)
    const inTarget = subtreeIds.has(e.target)
    let step: DuplicateEdgeStep | null = null
    if (inSource && inTarget) {
      if (internal) step = { sourceOriginalId: e.source, targetOriginalId: e.target, edgeType: e.edgeType }
    } else if (inTarget) {
      if (incoming) step = { sourceOriginalId: e.source, targetOriginalId: e.target, edgeType: e.edgeType, keeps: 'source' }
    } else if (inSource) {
      if (outgoing) step = { sourceOriginalId: e.source, targetOriginalId: e.target, edgeType: e.edgeType, keeps: 'target' }
    }
    if (!step) continue
    seen.add(key)
    edges.push(step)
  }

  return { nodes, edges }
}

/**
 * The entities a selection duplicates: each selected one, minus any that sits
 * inside another selected one — copying the parent already copies it, and
 * copying it again would make two copies of the same child.
 */
export function topmostOf(ids: readonly string[], parentOf: (id: string) => string | undefined): string[] {
  const chosen = new Set(ids)
  return ids.filter((id) => {
    const guard = new Set<string>()
    for (let p = parentOf(id); p && p !== id && !guard.has(p); p = parentOf(p)) {
      if (chosen.has(p)) return false
      guard.add(p)
    }
    return true
  })
}
