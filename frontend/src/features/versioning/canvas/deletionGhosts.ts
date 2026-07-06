/**
 * deletionGhosts — reconstruct committed-draft deletions as read-only "ghost" nodes/edges on the canvas.
 *
 * A delete that is only STAGED keeps its node (marked `isPending:'delete'`) so it shows in red. But
 * once SAVED to the draft the entity is a tombstone — absent from the draft's live state — so on
 * refresh the canvas re-hydrates without it and the red marker is lost, even though the deletion
 * isn't merged yet. The draft-vs-main diff (`activeChangeSet`) still knows about it (it's what the
 * Changes panel renders), and every `removed` change carries the entity's full `before` snapshot.
 *
 * This module rebuilds those deletions from the diff so they render (via the existing rose "removed"
 * decoration) in their ORIGINAL position until the draft is merged or the deletion is restored:
 *  - ghost NODES from removed node-changes (placed by their own `layerAssignment`), and
 *  - ghost EDGES from removed edge-changes — crucially the deleted CONTAINMENT edge, so a nested
 *    deletion nests back under its (live or ghost) parent instead of floating to the column root.
 *
 * Pure + generic: a ghost is just the entity's `before` state; the containment vs lineage split comes
 * from the ontology predicate the caller passes in — no edge-type hardcoding here.
 */
import type { ChangeSet, GraphChange } from '../model/changeModel'

export interface GhostNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, unknown> & { urn?: string; isGhost?: boolean }
}
export interface GhostEdge {
  id: string
  source: string
  target: string
  type: string
  data: Record<string, unknown> & { edgeType?: string; isGhost?: boolean }
}

type NodeLike = { id: string; data?: unknown }
type EdgeLike = { id: string; data?: unknown }

/** True for a node/edge this module synthesized (read-only, reconstructed from a committed deletion). */
export function isGhostNode(n: NodeLike): boolean {
  return (n.data as { isGhost?: unknown } | undefined)?.isGhost === true
}
export function isGhostEdge(e: EdgeLike): boolean {
  return (e.data as { isGhost?: unknown } | undefined)?.isGhost === true
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Build a read-only ghost canvas node from a committed `removed` node change's `before` snapshot. */
export function synthesizeGhostNode(c: GraphChange): GhostNode {
  const b = (c.before ?? {}) as Record<string, unknown>
  return {
    id: c.entityId,
    type: 'generic',
    position: { x: 0, y: 0 },   // LayerColumn lays out its own rows; position is unused here
    data: {
      label: (b.displayName as string) ?? c.label ?? c.entityId,
      type: b.entityType,
      urn: c.entityId,
      layerAssignment: b.layerAssignment,
      classifications: (b.tags as unknown[]) ?? [],
      properties: (b.properties as Record<string, unknown>) ?? {},
      childCount: (b.childCount as number) ?? 0,
      // Marks this as a reconstructed deletion — read-only, distinct from an optimistic
      // `isPending:'delete'` edit (a LIVE node still in the draft state). The rose ring comes from
      // the diff decoration keyed on the urn, so no pending flag is set here.
      isGhost: true,
    },
  }
}

/** Build a ghost canvas edge from a committed `removed` edge change's `before` snapshot. Returns null
 *  if endpoints are missing. `type` is 'containment' (so the hierarchy nests the child) vs 'lineage',
 *  decided by the ontology predicate — never by an edge-name literal. */
export function synthesizeGhostEdge(
  c: GraphChange,
  isContainmentEdgeType: (edgeType: string) => boolean,
): GhostEdge | null {
  const b = (c.before ?? {}) as Record<string, unknown>
  const source = str(b.sourceEntityId) ?? str(b.source_entity_id) ?? str(b.source)
  const target = str(b.targetEntityId) ?? str(b.target_entity_id) ?? str(b.target)
  if (!source || !target) return null
  const edgeType = str(b.edgeType) ?? str(b.edge_type)
  return {
    id: c.entityId,
    source,
    target,
    type: edgeType && isContainmentEdgeType(edgeType) ? 'containment' : 'lineage',
    data: {
      edgeType,
      ...(edgeType ? { relationship: edgeType.toLowerCase() } : {}),
      isGhost: true,
    },
  }
}

/**
 * Reconcile ghost nodes AND edges against the branch diff, so the canvas mirrors the draft's committed
 * deletions in their original position. Never touches live nodes/edges.
 *
 * - Nodes: add a `removed` node whose entity is neither live (the optimistic `isPending:'delete'` node)
 *   nor already a ghost; remove ghosts no longer removed (merged/restored) or all when the diff is hidden.
 * - Edges: add a `removed` edge only when BOTH endpoints are present on the canvas (live or ghost) — a
 *   re-added containment edge is what nests a deleted child under its parent; skip edges that would
 *   dangle (an endpoint that's neither live nor ghosted, e.g. out of view).
 */
export function reconcileGhosts(
  changeSet: ChangeSet | null,
  currentNodes: ReadonlyArray<NodeLike>,
  currentEdges: ReadonlyArray<EdgeLike>,
  committedHidden: boolean,
  isContainmentEdgeType: (edgeType: string) => boolean,
): { nodesToAdd: GhostNode[]; nodesToRemove: string[]; edgesToAdd: GhostEdge[]; edgesToRemove: string[] } {
  const changes = committedHidden ? [] : (changeSet?.changes ?? [])
  const removedNodes = changes.filter((c) => c.kind === 'node' && c.status === 'removed' && c.before)
  const removedEdges = changes.filter((c) => c.kind === 'edge' && c.status === 'removed' && c.before)
  const desiredNodes = new Set(removedNodes.map((c) => c.entityId))
  const desiredEdges = new Set(removedEdges.map((c) => c.entityId))

  const liveUrns = new Set<string>()
  const existingGhostNodes = new Set<string>()
  for (const n of currentNodes) (isGhostNode(n) ? existingGhostNodes : liveUrns).add(n.id)
  const existingGhostEdges = new Set(currentEdges.filter(isGhostEdge).map((e) => e.id))

  const nodesToAdd = removedNodes
    .filter((c) => !liveUrns.has(c.entityId) && !existingGhostNodes.has(c.entityId))
    .map(synthesizeGhostNode)
  const nodesToRemove = [...existingGhostNodes].filter((u) => !desiredNodes.has(u))

  // Everything that will be on the canvas after this pass — the valid endpoint set for ghost edges.
  const present = new Set<string>([...liveUrns, ...existingGhostNodes, ...nodesToAdd.map((n) => n.id)])
  for (const u of nodesToRemove) present.delete(u)

  const edgesToAdd = removedEdges
    .filter((c) => !existingGhostEdges.has(c.entityId))
    .map((c) => synthesizeGhostEdge(c, isContainmentEdgeType))
    .filter((e): e is GhostEdge => !!e && present.has(e.source) && present.has(e.target))
  const edgesToRemove = [...existingGhostEdges].filter((id) => !desiredEdges.has(id))

  return { nodesToAdd, nodesToRemove, edgesToAdd, edgesToRemove }
}

/** The staged `create_entity` input that RESTORES (resurrects) a committed deletion: it carries the
 *  entity's ORIGINAL urn (→ create-over-tombstone on Save) + its `before` fields, and re-nests it
 *  under its parent — but only when that parent is still LIVE (a still-deleted parent can't hold a
 *  restored child; restore the parent first). Returns null if the urn isn't a committed deletion.
 *  Pure; the caller stages it + flips the ghost node live. */
export interface RestoreChangeInput {
  type: 'create_entity'
  targetId: string
  targetUrn: string
  after: Record<string, unknown>
  summary: string
}
export function buildRestoreChange(
  urn: string,
  changeSet: ChangeSet | null,
  presentUrns: ReadonlySet<string>,
  isContainmentEdgeType: (edgeType: string) => boolean,
): RestoreChangeInput | null {
  const changes = changeSet?.changes ?? []
  const nodeChange = changes.find(
    (c) => c.kind === 'node' && c.status === 'removed' && c.entityId === urn && c.before,
  )
  if (!nodeChange?.before) return null
  const b = nodeChange.before as Record<string, unknown>

  const edgeBefore = (c: GraphChange) => (c.before ?? {}) as Record<string, unknown>
  const parentEdge = changes.find((c) => {
    if (c.kind !== 'edge' || c.status !== 'removed' || !c.before) return false
    const e = edgeBefore(c)
    const tgt = str(e.targetEntityId) ?? str(e.target_entity_id) ?? str(e.target)
    const et = str(e.edgeType) ?? str(e.edge_type) ?? ''
    return tgt === urn && isContainmentEdgeType(et)
  })
  const pe = parentEdge ? edgeBefore(parentEdge) : undefined
  const parentUrn = pe ? (str(pe.sourceEntityId) ?? str(pe.source_entity_id) ?? str(pe.source)) : undefined
  const edgeType = pe ? (str(pe.edgeType) ?? str(pe.edge_type)) : undefined
  const nest = !!(parentUrn && edgeType && presentUrns.has(parentUrn))

  return {
    type: 'create_entity',
    targetId: urn,
    targetUrn: urn,
    after: {
      // Replay the ENTIRE deleted snapshot so nothing is lost (qualifiedName, sourceSystem,
      // layerAssignment, description, …). stagedChangesToOps carries every user-authored field; the
      // server-managed ones (childCount/lastSyncedAt) are recomputed on write.
      ...b,
      urn,
      ...(nest ? { parentUrn, containmentEdgeType: edgeType } : {}),
    },
    summary: `Restore ${str(b.entityType) ?? 'entity'}: '${str(b.displayName) ?? urn}'`,
  }
}

/** Restore a deleted entity AND its deleted descendants (the cascade-deleted subtree), parent-first,
 *  each re-nested under its parent (live, or a subtree member also being restored). Walks the removed
 *  containment edges down from `rootUrn`. A leaf collapses to a single restore. */
export function buildRestoreSubtree(
  rootUrn: string,
  changeSet: ChangeSet | null,
  liveUrns: ReadonlySet<string>,
  isContainmentEdgeType: (edgeType: string) => boolean,
): RestoreChangeInput[] {
  const changes = changeSet?.changes ?? []
  const isRemovedNode = (u: string) =>
    changes.some((c) => c.kind === 'node' && c.status === 'removed' && c.entityId === u && c.before)

  // parent urn → deleted child urns, from removed CONTAINMENT edges only.
  const childrenOf = new Map<string, string[]>()
  for (const c of changes) {
    if (c.kind !== 'edge' || c.status !== 'removed' || !c.before) continue
    const e = c.before as Record<string, unknown>
    const et = str(e.edgeType) ?? str(e.edge_type) ?? ''
    if (!isContainmentEdgeType(et)) continue
    const src = str(e.sourceEntityId) ?? str(e.source_entity_id) ?? str(e.source)
    const tgt = str(e.targetEntityId) ?? str(e.target_entity_id) ?? str(e.target)
    if (src && tgt) childrenOf.set(src, [...(childrenOf.get(src) ?? []), tgt])
  }

  // BFS from the root over removed nodes → parent-before-child order.
  const order: string[] = []
  const seen = new Set<string>()
  const queue = [rootUrn]
  while (queue.length) {
    const u = queue.shift()!
    if (seen.has(u) || !isRemovedNode(u)) continue
    seen.add(u)
    order.push(u)
    for (const ch of childrenOf.get(u) ?? []) queue.push(ch)
  }

  // A subtree child's parent isn't "live" yet — it's being restored too. Treat the whole restore set
  // as present so descendants re-nest under their (restored) parents.
  const willBePresent = new Set<string>([...liveUrns, ...order])
  return order
    .map((u) => buildRestoreChange(u, changeSet, willBePresent, isContainmentEdgeType))
    .filter((r): r is RestoreChangeInput => !!r)
}
