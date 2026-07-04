/**
 * useDuplicateSubtree — recreate an entity AND its entire descendant subtree
 * as freshly-STAGED entities (clean staged urns, `duplicatedFrom` provenance,
 * internal lineage preserved).
 *
 * Replaces the old "Duplicate" behaviour, which copied only the single node
 * into the canvas as a LOCAL fake node (`${urn}-copy-${Date.now()}`) that
 * inherited the original's `childCount` — expanding it then called
 * `loadChildren` against a node the backend never saw, surfacing "Failed to
 * load — click to retry" (see useCanvasInteractions.ts's old `duplicateNode`).
 *
 * Strategy:
 *  1. Load the FULL subtree first (recursively, awaited) — a still-collapsed
 *     descendant must not be silently dropped from the copy.
 *  2. Snapshot the now-fully-loaded subtree from the canvas store and hand it
 *     to the pure `planDuplicate` planner (see planDuplicate.ts) to compute
 *     the ordered staging plan — copy identifiers, provenance, and internal
 *     vs. cross-boundary lineage are ALL decided there, not here.
 *  3. Execute the plan: `stageEntity` per node (top-down, so each child's
 *     `parentUrn` threads the parent's just-staged temp urn), then stage the
 *     internal lineage edges once every copy exists.
 */
import { useCallback } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useViewIsContainmentEdge } from '@/hooks/useViewSchema'
import { normalizeEdgeType } from '@/store/schema'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { generateId } from '@/lib/utils'
import { planDuplicate, type DuplicateSourceNode, type DuplicateLineageEdgeInput } from './planDuplicate'

/** Defensive caps while loading the subtree — guard against cycles or a
 *  runaway hierarchy stalling the duplicate action indefinitely. */
const MAX_DEPTH = 50
const MAX_LOAD_PAGES_PER_NODE = 50

export interface UseDuplicateSubtreeResult {
  /**
   * Duplicate `nodeId`'s entire subtree as freshly-staged entities. Returns
   * the new root copy's staged urn, or null when the node can't be found or
   * no draft could be opened.
   */
  duplicateSubtree: (nodeId: string) => Promise<string | null>
}

export function useDuplicateSubtree(): UseDuplicateSubtreeResult {
  const { stageEntity } = useStageEntityCreation()
  const { loadChildren } = useGraphHydration()
  const isContainmentEdge = useViewIsContainmentEdge()

  const duplicateSubtree = useCallback(async (nodeId: string): Promise<string | null> => {
    const draftId = await ensureDraftOpen()
    if (!draftId) return null

    if (!useCanvasStore.getState().nodes.some((n) => n.id === nodeId)) return null

    const countLoadedContainmentChildren = (id: string): number =>
      useCanvasStore.getState().edges.filter(
        (e) => e.source === id && isContainmentEdge(normalizeEdgeType(e)),
      ).length

    // Load the FULL subtree first (depth-first, awaited) so collapsed /
    // not-yet-fetched descendants are materialized before anything is
    // copied — otherwise the copy would silently drop children the user
    // never happened to expand.
    const loadSubtree = async (id: string, depth: number, visited: Set<string>): Promise<void> => {
      if (depth > MAX_DEPTH || visited.has(id)) return
      visited.add(id)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
      if (!node) return

      const childCount = (node.data.childCount as number) ?? 0
      let loaded = countLoadedContainmentChildren(id)
      let pages = 0
      while (loaded < childCount && pages < MAX_LOAD_PAGES_PER_NODE) {
        await loadChildren(id)
        const nowLoaded = countLoadedContainmentChildren(id)
        if (nowLoaded <= loaded) break // no progress — stop rather than loop forever
        loaded = nowLoaded
        pages += 1
      }

      const childIds = useCanvasStore.getState().edges
        .filter((e) => e.source === id && isContainmentEdge(normalizeEdgeType(e)))
        .map((e) => e.target)
      for (const childId of childIds) {
        await loadSubtree(childId, depth + 1, visited)
      }
    }
    await loadSubtree(nodeId, 0, new Set())

    // Snapshot the fully-loaded subtree.
    const { nodes, edges } = useCanvasStore.getState()
    const nodeById = new Map(nodes.map((n) => [n.id, n]))

    // Containment child map + each node's OWN incoming containment edge type
    // (reused on the copy's parent→copy edge for ontology fidelity).
    const childMap = new Map<string, string[]>()
    const incomingContainmentType = new Map<string, string>()
    for (const e of edges) {
      if (!isContainmentEdge(normalizeEdgeType(e))) continue
      if (!childMap.has(e.source)) childMap.set(e.source, [])
      childMap.get(e.source)!.push(e.target)
      const edgeType = e.data?.edgeType || e.data?.relationship
      if (edgeType) incomingContainmentType.set(e.target, edgeType)
    }

    // Walk the subtree (root + all descendants) from the child map.
    const subtreeIds: string[] = []
    const collect = (id: string, visited: Set<string>) => {
      if (visited.has(id)) return
      visited.add(id)
      subtreeIds.push(id)
      for (const childId of childMap.get(id) ?? []) collect(childId, visited)
    }
    collect(nodeId, new Set())

    const nodeData = new Map<string, DuplicateSourceNode>()
    for (const id of subtreeIds) {
      const n = nodeById.get(id)
      if (!n) continue
      nodeData.set(id, {
        urn: (n.data.urn as string) ?? id,
        entityType: n.data.type as string,
        displayName: n.data.label as string,
        tags: (n.data.classifications as string[]) ?? [],
        properties: (n.data.properties as Record<string, unknown>) ?? {},
        containmentEdgeType: incomingContainmentType.get(id),
      })
    }

    // Candidate lineage edges — non-containment edges touching the subtree.
    // planDuplicate decides internal-vs-cross-boundary; only edges with BOTH
    // endpoints copied are recreated.
    const subtreeIdSet = new Set(subtreeIds)
    const lineageEdges: DuplicateLineageEdgeInput[] = edges
      .filter((e) =>
        !isContainmentEdge(normalizeEdgeType(e))
        && (subtreeIdSet.has(e.source) || subtreeIdSet.has(e.target)),
      )
      .map((e) => ({
        source: e.source,
        target: e.target,
        edgeType: (e.data?.edgeType || e.data?.relationship || '') as string,
      }))

    const plan = planDuplicate(nodeId, childMap, nodeData, lineageEdges)

    // The root copy is a SIBLING of the original — same parent (if any).
    const originalParentEdge = edges.find(
      (e) => e.target === nodeId && isContainmentEdge(normalizeEdgeType(e)),
    )
    const originalParentUrn = originalParentEdge?.source

    const stagedUrns = new Map<string, string>() // originalId -> staged urn
    let rootCopyUrn: string | null = null
    for (const step of plan.nodes) {
      const parentUrn = step.parentOriginalId !== null
        ? stagedUrns.get(step.parentOriginalId)
        : originalParentUrn
      const stagedUrn = stageEntity({
        entityType: step.entityType,
        displayName: step.displayName,
        parentUrn,
        tags: step.tags,
        properties: step.properties,
        containmentEdgeType: step.containmentEdgeType,
      })
      stagedUrns.set(step.originalId, stagedUrn)
      if (step.parentOriginalId === null) rootCopyUrn = stagedUrn
    }

    // Internal lineage edges — AFTER all nodes are staged, so both endpoint
    // copies exist. Recreated directly as a staged create_edge (the original
    // edge was already ontology-valid, so re-running the draw-time gate here
    // would be redundant — see CreateLinkPopover for the user-drawn path that
    // DOES need it).
    for (const edgeStep of plan.edges) {
      const src = stagedUrns.get(edgeStep.sourceOriginalId)
      const tgt = stagedUrns.get(edgeStep.targetOriginalId)
      if (!src || !tgt) continue

      const tempId = generateId('staged-edge')
      useCanvasStore.getState().addEdges([{
        id: tempId,
        source: src,
        target: tgt,
        type: 'lineage',
        data: { edgeType: edgeStep.edgeType, relationship: edgeStep.edgeType.toLowerCase() },
      }])
      useStagedChangesStore.getState().stage({
        type: 'create_edge',
        targetId: tempId,
        after: { edgeType: edgeStep.edgeType, source: src, target: tgt },
        summary: `Create ${edgeStep.edgeType} edge ${src} → ${tgt} (duplicated)`,
        apply: async ({ provider, resolveTempId }) => {
          if (!provider) return // local-only (no backend) — accept optimistically
          const resolvedSrc = resolveTempId(src) ?? src
          const resolvedTgt = resolveTempId(tgt) ?? tgt
          const res = await provider.createEdge({ sourceUrn: resolvedSrc, targetUrn: resolvedTgt, edgeType: edgeStep.edgeType })
          if (!res.success) throw new Error(res.error || 'Failed to create edge')
        },
        discard: () => useCanvasStore.getState().removeEdge(tempId),
      })
    }

    return rootCopyUrn
  }, [stageEntity, loadChildren, isContainmentEdge])

  return { duplicateSubtree }
}
