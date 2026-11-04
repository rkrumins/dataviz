/**
 * useDuplicateSubtree — recreate an entity (and, by default, its entire
 * descendant subtree) as freshly-STAGED entities: clean staged urns,
 * `duplicatedFrom` provenance, the edges inside the copy recreated, and —
 * when asked — its incoming and outgoing relationships too.
 *
 * Replaces the old "Duplicate" behaviour, which copied only the single node
 * into the canvas as a LOCAL fake node (`${urn}-copy-${Date.now()}`) that
 * inherited the original's `childCount` — expanding it then called
 * `loadChildren` against a node the backend never saw, surfacing "Failed to
 * load — click to retry" (see useCanvasInteractions.ts's old `duplicateNode`).
 *
 * Two steps, so the Duplicate… dialog can say exactly what will happen before
 * anything is staged:
 *  1. `prepareDuplicate` loads the FULL subtree (recursively, awaited — a
 *     still-collapsed descendant must not be silently dropped), snapshots it,
 *     and — when relationships across the boundary are wanted — reads the
 *     subtree's edges from the SERVER, not just the ones the canvas happens to
 *     have loaded. The result answers `count(choice)` for any choice, without
 *     fetching again.
 *  2. `commitDuplicate` hands the snapshot to the pure `planDuplicate` planner
 *     (identifiers, provenance, inside vs. boundary edges are ALL decided
 *     there) and executes the plan: `stageEntity` per node (top-down, so each
 *     child's `parentUrn` threads its parent's just-staged temp urn), then the
 *     edges once every copy exists.
 *
 * `duplicateSubtree` is both at once with today's defaults (⌘D).
 */
import { useCallback } from 'react'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useViewIsContainmentEdge } from '@/hooks/useViewSchema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { normalizeEdgeType } from '@/store/schema'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { generateId } from '@/lib/utils'
import {
  planDuplicate,
  type DuplicateSourceNode,
  type DuplicateLineageEdgeInput,
  type PlanDuplicateOptions,
} from './planDuplicate'

/** Defensive caps while loading the subtree — guard against cycles or a
 *  runaway hierarchy stalling the duplicate action indefinitely. */
const MAX_DEPTH = 50
const MAX_LOAD_PAGES_PER_NODE = 50

/** A copy this big asks first; past the maximum it is refused. Staging is
 *  client-side, and a few thousand creates is where a draft save gets slow. */
export const DUPLICATE_CONFIRM_ABOVE = 200
export const DUPLICATE_MAX = 2000
/** Relationships across the boundary, per direction: Bulk Link's limits. */
export const BOUNDARY_CONFIRM_ABOVE = 50
export const BOUNDARY_MAX = 500
/** URNs per server read of the subtree's edges. */
const EDGE_READ_CHUNK = 400

/** The synthetic rollup type: a summary of real edges, never one to copy. */
const ROLLUP = 'AGGREGATED'

/** What a duplicate copies — the planner's options, plus the copy's name. */
export interface DuplicateChoice extends Required<PlanDuplicateOptions> {
  /** The root copy's name; default "{name} (Copy)". */
  name?: string
}

/** ⌘D: the whole subtree with the edges inside it — the behaviour Duplicate always had. */
export const QUICK_DUPLICATE: DuplicateChoice = { includeDescendants: true, internal: true, incoming: false, outgoing: false }

export interface DuplicateCounts {
  entities: number
  internal: number
  incoming: number
  outgoing: number
}

/** One entity, ready to duplicate: its subtree loaded and its edges read. */
export interface PreparedDuplicate {
  nodeId: string
  label: string
  entityType: string
  /** Entities inside it, loaded in full — or at least this many when `tooBig`. */
  descendants: number
  /** The subtree runs past DUPLICATE_MAX: loading stopped there. */
  tooBig: boolean
  /** The boundary was read from the server (asked for in `prepareDuplicate`). */
  boundaryRead: boolean
  /** A boundary read reached BOUNDARY_MAX + 1 in a direction: that count is "more than". */
  boundaryCapped: { incoming: boolean; outgoing: boolean }
  /** What a choice would create — from the snapshot, no fetching. */
  count: (choice: DuplicateChoice) => DuplicateCounts
  /** @internal the snapshot `commitDuplicate` stages from. */
  snapshot: DuplicateSnapshot
}

interface DuplicateSnapshot {
  childMap: Map<string, string[]>
  nodeData: Map<string, DuplicateSourceNode>
  lineageEdges: DuplicateLineageEdgeInput[]
  originalParentUrn: string | undefined
}

export interface UseDuplicateSubtreeOptions {
  /** Fired per staged copy (root + every descendant) as it is created, so a
   *  layered canvas can assign each copy to its original's layer. */
  onNodeCopied?: (originalId: string, originalUrn: string, copyUrn: string) => void
}

export interface UseDuplicateSubtreeResult {
  /**
   * Load what duplicating `nodeId` involves. `boundary: true` also reads its
   * relationships to entities outside the copy from the server (the dialog's
   * incoming / outgoing counts). Null when the node can't be found or no
   * draft could be opened.
   */
  prepareDuplicate: (nodeId: string, opts?: { boundary?: boolean }) => Promise<PreparedDuplicate | null>
  /** Stage the copy. Returns the root copy's staged urn, or null when refused (too big). */
  commitDuplicate: (prepared: PreparedDuplicate, choice: DuplicateChoice) => string | null
  /**
   * Duplicate `nodeId` in one go with `choice` (default: the whole subtree
   * and the edges inside it). Returns the new root copy's staged urn, or null.
   */
  duplicateSubtree: (nodeId: string, choice?: DuplicateChoice) => Promise<string | null>
}

export function useDuplicateSubtree(opts?: UseDuplicateSubtreeOptions): UseDuplicateSubtreeResult {
  const { stageEntity } = useStageEntityCreation()
  const { loadChildren } = useGraphHydration()
  const isContainmentEdge = useViewIsContainmentEdge()
  const provider = useGraphProvider()

  const prepareDuplicate = useCallback(async (
    nodeId: string,
    prepOpts?: { boundary?: boolean },
  ): Promise<PreparedDuplicate | null> => {
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
    // never happened to expand. Stops once it is clearly too big to copy.
    let loadedTotal = 0
    let tooBig = false
    const loadSubtree = async (id: string, depth: number, visited: Set<string>): Promise<void> => {
      if (tooBig || depth > MAX_DEPTH || visited.has(id)) return
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
      loadedTotal += childIds.length
      if (loadedTotal > DUPLICATE_MAX) { tooBig = true; return }
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
      // Set by the canvas node mapper (toCanvasNode); not declared on the node data type.
      const sourceSystem = (n.data as { sourceSystem?: string }).sourceSystem
      nodeData.set(id, {
        urn: (n.data.urn as string) ?? id,
        entityType: n.data.type as string,
        displayName: n.data.label as string,
        tags: (n.data.classifications as string[]) ?? [],
        properties: (n.data.properties as Record<string, unknown>) ?? {},
        description: n.data.description as string | undefined,
        containmentEdgeType: incomingContainmentType.get(id),
        ...(sourceSystem ? { sourceSystem } : {}),
      })
    }

    // Candidate relationships — every non-containment edge touching the
    // subtree, as loaded on the canvas; planDuplicate decides inside vs.
    // boundary, and which of those the choice copies.
    const subtreeIdSet = new Set(subtreeIds)
    const copyable = (edgeType: string) => {
      const t = edgeType.toUpperCase()
      return !!t && t !== ROLLUP && !isContainmentEdge(t)
    }
    const lineageEdges: DuplicateLineageEdgeInput[] = edges
      .filter((e) =>
        !isContainmentEdge(normalizeEdgeType(e))
        && normalizeEdgeType(e) !== ROLLUP
        && (subtreeIdSet.has(e.source) || subtreeIdSet.has(e.target)),
      )
      .map((e) => ({
        source: e.source,
        target: e.target,
        edgeType: (e.data?.edgeType || e.data?.relationship || '') as string,
      }))

    // The boundary, read from the server: the canvas holds only the edges it
    // has drawn, and a duplicate must not quietly lose the rest.
    const boundaryCapped = { incoming: false, outgoing: false }
    const boundaryRead = !!prepOpts?.boundary && !tooBig
    if (boundaryRead) {
      const urns = subtreeIds.map((id) => (nodeById.get(id)?.data.urn as string) ?? id)
      const readSide = async (side: 'incoming' | 'outgoing') => {
        let crossing = 0
        for (let i = 0; i < urns.length; i += EDGE_READ_CHUNK) {
          const chunk = urns.slice(i, i + EDGE_READ_CHUNK)
          const found = await provider.getEdges(side === 'incoming'
            ? { targetUrns: chunk, limit: BOUNDARY_MAX + 1 }
            : { sourceUrns: chunk, limit: BOUNDARY_MAX + 1 })
          for (const e of found) {
            if (!copyable(e.edgeType)) continue
            const outside = side === 'incoming' ? !subtreeIdSet.has(e.sourceUrn) : !subtreeIdSet.has(e.targetUrn)
            if (outside) crossing++
            lineageEdges.push({ source: e.sourceUrn, target: e.targetUrn, edgeType: e.edgeType })
          }
          if (crossing > BOUNDARY_MAX) { boundaryCapped[side] = true; break }
        }
      }
      await Promise.all([readSide('incoming'), readSide('outgoing')])
    }

    // The root copy is a SIBLING of the original — same parent (if any).
    const originalParentEdge = edges.find(
      (e) => e.target === nodeId && isContainmentEdge(normalizeEdgeType(e)),
    )
    const snapshot: DuplicateSnapshot = {
      childMap,
      nodeData,
      lineageEdges,
      originalParentUrn: originalParentEdge?.source,
    }
    const root = nodeById.get(nodeId)

    return {
      nodeId,
      label: (root?.data.label as string) ?? nodeId,
      entityType: (root?.data.type as string) ?? '',
      descendants: Math.max(0, subtreeIds.length - 1),
      tooBig,
      boundaryRead,
      boundaryCapped,
      count: (choice) => {
        const plan = planDuplicate(nodeId, childMap, nodeData, lineageEdges, choice)
        return {
          entities: plan.nodes.length,
          internal: plan.edges.filter((e) => !e.keeps).length,
          incoming: plan.edges.filter((e) => e.keeps === 'source').length,
          outgoing: plan.edges.filter((e) => e.keeps === 'target').length,
        }
      },
      snapshot,
    }
  }, [loadChildren, isContainmentEdge, provider])

  const commitDuplicate = useCallback((prepared: PreparedDuplicate, choice: DuplicateChoice): string | null => {
    if (prepared.tooBig && choice.includeDescendants) return null
    const { childMap, nodeData, lineageEdges, originalParentUrn } = prepared.snapshot
    const plan = planDuplicate(prepared.nodeId, childMap, nodeData, lineageEdges, choice)
    if (plan.nodes.length > DUPLICATE_MAX) return null

    const stagedUrns = new Map<string, string>() // originalId -> staged urn
    let rootCopyUrn: string | null = null
    for (const step of plan.nodes) {
      const parentUrn = step.parentOriginalId !== null
        ? stagedUrns.get(step.parentOriginalId)
        : originalParentUrn
      const isRoot = step.parentOriginalId === null
      // Description and source system are NODE fields — filed under `properties` they would land
      // as a user property the server reserves (see StageEntityInput), so the copy's own
      // description would read empty. The planner carries the description in the bag; it leaves
      // it here.
      const { description, ...properties } = step.properties
      const stagedUrn = stageEntity({
        entityType: step.entityType,
        displayName: isRoot && choice.name?.trim() ? choice.name.trim() : step.displayName,
        parentUrn,
        tags: step.tags,
        description: typeof description === 'string' ? description : undefined,
        sourceSystem: step.sourceSystem,
        properties,
        containmentEdgeType: step.containmentEdgeType,
      })
      stagedUrns.set(step.originalId, stagedUrn)
      if (isRoot) rootCopyUrn = stagedUrn
      opts?.onNodeCopied?.(step.originalId, step.originalUrn, stagedUrn)
    }

    // Edges — AFTER all nodes are staged, so every copied endpoint exists. A
    // boundary edge keeps its original partner at one end. Recreated directly
    // as a staged create_edge: each copies an edge that already passed the
    // ontology between the same two types (see CreateLinkPopover for the
    // user-drawn path that DOES need the draw-time gate).
    for (const edgeStep of plan.edges) {
      const src = edgeStep.keeps === 'source' ? edgeStep.sourceOriginalId : stagedUrns.get(edgeStep.sourceOriginalId)
      const tgt = edgeStep.keeps === 'target' ? edgeStep.targetOriginalId : stagedUrns.get(edgeStep.targetOriginalId)
      if (!src || !tgt) continue

      const tempId = generateId('staged-edge')
      const copy: LineageEdge = {
        id: tempId,
        source: src,
        target: tgt,
        type: 'lineage',
        // Unsaved, as a drawn link is: a collapse keeps it, the save redraws it under its real id.
        data: { edgeType: edgeStep.edgeType, relationship: edgeStep.edgeType.toLowerCase(), isPending: 'create' },
      }
      useCanvasStore.getState().addEdges([copy])
      useStagedChangesStore.getState().stage({
        type: 'create_edge',
        targetId: tempId,
        after: { edgeType: edgeStep.edgeType, source: src, target: tgt },
        summary: `Create ${edgeStep.edgeType} edge ${src} → ${tgt} (duplicated)`,
        apply: async ({ provider: p, resolveTempId }) => {
          if (!p) return // local-only (no backend) — accept optimistically
          const resolvedSrc = resolveTempId(src) ?? src
          const resolvedTgt = resolveTempId(tgt) ?? tgt
          const res = await p.createEdge({ sourceUrn: resolvedSrc, targetUrn: resolvedTgt, edgeType: edgeStep.edgeType })
          if (!res.success) throw new Error(res.error || 'Failed to create edge')
        },
        discard: () => useCanvasStore.getState().removeEdge(tempId),
        reapply: () => useCanvasStore.getState().addEdges([copy]),   // redo draws it again
      })
    }

    return rootCopyUrn
  }, [stageEntity, opts?.onNodeCopied])

  const duplicateSubtree = useCallback(async (nodeId: string, choice: DuplicateChoice = QUICK_DUPLICATE): Promise<string | null> => {
    const prepared = await prepareDuplicate(nodeId, { boundary: choice.incoming || choice.outgoing })
    if (!prepared) return null
    return commitDuplicate(prepared, choice)
  }, [prepareDuplicate, commitDuplicate])

  return { prepareDuplicate, commitDuplicate, duplicateSubtree }
}
