/**
 * stageBuildRows — O(n) batch staging for a whole `BuildRow[]` tree.
 *
 * The per-row path (`useStageEntityCreation.stageEntity`, and the loop in
 * `useHierarchyOutline.stageRows`) does a full-canvas parent `find` plus a
 * full-array-copy `addNodes`/`stage` call PER ROW — each O(n), so staging a
 * whole pasted-in hierarchy is O(n²). `planBuildStaging` is the pure
 * planner: it mints every row's temp urn up front (a `Map<rowId, tempUrn>`,
 * O(1) lookup per parent) and builds the nodes/edges/changes arrays in ONE
 * pass. `useStageBuildRows` commits that plan with a single `addNodes` +
 * `addEdges` + `stageMany` call — one state update per store instead of one
 * per row — then fires `onRowStaged` per row for the caller's layer
 * assignment (mirrors `useDuplicateSubtree`'s `onNodeCopied`).
 *
 * Each row's `create_entity` change mirrors `useStageEntityCreation.stageEntity`
 * exactly: same optimistic node/edge shape, same `apply`/`discard` hooks
 * (`provider.createNode` payload, temp-id resolution for a staged parent).
 */
import { useCallback } from 'react'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useViewRelationshipTypes, useViewContainmentEdgeTypes } from '@/hooks/useViewSchema'
import { deriveContainmentEdges } from '@/services/ontologyPreflightService'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { generateId } from '@/lib/utils'
import type { BuildRow } from './buildRow'

export interface BuildStagingPlan {
  nodes: LineageNode[]
  edges: LineageEdge[]
  changes: StagedChange[]
  /** BuildRow.id -> its staged temp urn. */
  rowUrn: Map<string, string>
}

export interface PlanBuildStagingOptions {
  /** Real canvas urn the whole batch attaches under (its batch-root rows'
   *  parent), or null for a top-level create. */
  rootParentUrn: string | null
  /** Resolves the containment edge type for a parent/child type pair.
   *  `parentType` is `''` for a batch-root row (no BuildRow parent) — the
   *  caller resolves `rootParentUrn`'s real type itself, if it needs one. */
  containmentEdgeTypeFor: (parentType: string, childType: string) => string
}

/**
 * Pure: `BuildRow[]` -> the exact optimistic nodes/edges and `create_entity`
 * changes to commit, with temp urns threaded parent -> child. No store/React.
 *
 * Two linear passes over `rows` (no per-row canvas scan): (1) mint every
 * row's temp urn — independent of order — into `rowUrn`, so (2) can resolve
 * ANY row's parent urn via an O(1) map lookup instead of a full-array
 * `find`. Pass 2 walks rows in depth order (already precomputed on
 * `BuildRow`, so this is a plain sort, not a re-derivation) purely to assign
 * strictly increasing `timestamp`s — a parent's `create_entity` change must
 * get an earlier timestamp than its children's, since `applyAll` applies
 * creates in timestamp order and a child's `apply` resolves its parent's
 * temp urn via `resolveTempId` (only populated once the parent's own apply
 * has run).
 */
export function planBuildStaging(rows: BuildRow[], opts: PlanBuildStagingOptions): BuildStagingPlan {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rowUrn = new Map<string, string>()
  for (const row of rows) {
    rowUrn.set(row.id, `urn:staged:${row.typeId}:${crypto.randomUUID()}`)
  }

  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const changes: StagedChange[] = []

  const ordered = [...rows].sort((a, b) => a.depth - b.depth)
  const baseTs = Date.now()

  ordered.forEach((row, i) => {
    const tempUrn = rowUrn.get(row.id)!
    const entityType = row.typeId ?? ''
    const parentRow = row.parentId != null ? byId.get(row.parentId) : undefined
    const parentUrn = parentRow ? rowUrn.get(parentRow.id) : (opts.rootParentUrn ?? undefined)
    const parentType = parentRow ? (parentRow.typeId ?? '') : ''
    const containmentEdgeType = parentUrn ? opts.containmentEdgeTypeFor(parentType, entityType) : undefined
    const containmentEdgeId = parentUrn ? `contains-${parentUrn}-${tempUrn}` : null

    const tags = row.tags ?? []
    const properties = row.properties ?? {}

    nodes.push({
      id: tempUrn,
      type: 'generic',
      position: { x: 0, y: 0 },
      data: {
        label: row.name,
        type: entityType,
        urn: tempUrn,
        classifications: tags,
        isPending: 'create',
        properties,
      },
    })

    if (containmentEdgeId && parentUrn && containmentEdgeType) {
      edges.push({
        id: containmentEdgeId,
        source: parentUrn,
        target: tempUrn,
        type: 'containment',
        data: { edgeType: containmentEdgeType, relationship: containmentEdgeType.toLowerCase(), isPending: 'create' },
      })
    }

    // Shared with `patchAfter`/`updateStagedEntity` in useStageEntityCreation:
    // mutated in place post-stage, so `apply` (reading from this same object)
    // observes edits made after staging.
    const afterState = {
      entityType, displayName: row.name, parentUrn, tags, properties,
      ...(parentUrn && containmentEdgeType ? { containmentEdgeType, parentLabel: parentRow?.name } : {}),
    }

    changes.push({
      id: generateId('staged'),
      type: 'create_entity',
      targetId: tempUrn,
      targetUrn: tempUrn,
      after: afterState,
      summary: parentUrn
        ? `Create ${entityType}: '${row.name}' · ${containmentEdgeType}${parentRow ? ` ${parentRow.name}` : ''}`
        : `Create ${entityType}: '${row.name}'`,
      timestamp: baseTs + i,
      apply: async ({ provider, registerTempIdResolution, resolveTempId }) => {
        if (!provider) {
          // No provider — accept the local-only creation by clearing the pending flag.
          useCanvasStore.getState().updateNode(tempUrn, { isPending: undefined })
          return
        }
        const resolvedParent = parentUrn ? (resolveTempId(parentUrn) ?? parentUrn) : undefined
        const result = await provider.createNode({
          entityType: entityType as never,
          displayName: afterState.displayName,
          parentUrn: resolvedParent,
          containmentEdgeType: parentUrn ? containmentEdgeType : undefined,
          properties: afterState.properties,
          tags: afterState.tags,
        })
        if (!result.success || !result.node) {
          throw new Error(result.error || 'Failed to create entity')
        }
        registerTempIdResolution(tempUrn, result.node.urn)
        const stagedChildCount = useCanvasStore.getState().edges.filter(
          (e) => e.source === tempUrn && e.type === 'containment' && e.data?.isPending === 'create',
        ).length
        useCanvasStore.getState().removeNode(tempUrn)
        if (containmentEdgeId) useCanvasStore.getState().removeEdge(containmentEdgeId)
        const swapped = toCanvasNode(result.node)
        swapped.data.childCount = Math.max(result.node.childCount ?? 0, stagedChildCount)
        useCanvasStore.getState().addNodes([swapped])
        if (result.containmentEdge) {
          useCanvasStore.getState().addEdges([{
            id: result.containmentEdge.id,
            source: result.containmentEdge.sourceUrn,
            target: result.containmentEdge.targetUrn,
            type: 'containment',
            data: { edgeType: result.containmentEdge.edgeType, relationship: 'contains' },
          }])
        }
      },
      discard: () => {
        if (containmentEdgeId) useCanvasStore.getState().removeEdge(containmentEdgeId)
        useCanvasStore.getState().removeNode(tempUrn)
      },
    })
  })

  return { nodes, edges, changes, rowUrn }
}

export interface StageBuildRowsOptions {
  /** Real canvas urn the batch's root rows attach under, or null for a top-level create. */
  rootParentUrn: string | null
  /** Fired per staged row (in no particular order) so the caller can assign layers. */
  onRowStaged?: (rowId: string, urn: string) => void
}

export function useStageBuildRows(): {
  stageBuildRows: (rows: BuildRow[], opts: StageBuildRowsOptions) => Promise<Map<string, string>>
} {
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()

  const stageBuildRows = useCallback(
    async (rows: BuildRow[], opts: StageBuildRowsOptions): Promise<Map<string, string>> => {
      await ensureDraftOpen()

      const rootParentType = opts.rootParentUrn
        ? ((useCanvasStore.getState().nodes.find(
            (n) => n.id === opts.rootParentUrn || (n.data?.urn as string) === opts.rootParentUrn,
          )?.data?.type as string) ?? '')
        : ''

      const containmentEdgeTypeFor = (parentType: string, childType: string): string => {
        const pt = parentType || rootParentType
        const allowed = deriveContainmentEdges(pt, childType, relationshipTypes, containmentEdgeTypes).filter(
          (e) => e.allowed,
        )
        const contains = allowed.find((e) => e.edgeType.toUpperCase() === 'CONTAINS')
        return (contains ?? allowed[0])?.edgeType ?? containmentEdgeTypes[0] ?? 'CONTAINS'
      }

      const plan = planBuildStaging(rows, { rootParentUrn: opts.rootParentUrn, containmentEdgeTypeFor })

      useCanvasStore.getState().addNodes(plan.nodes)
      useCanvasStore.getState().addEdges(plan.edges)
      useStagedChangesStore.getState().stageMany(plan.changes)

      for (const row of rows) {
        const urn = plan.rowUrn.get(row.id)
        if (urn) opts.onRowStaged?.(row.id, urn)
      }

      return plan.rowUrn
    },
    [relationshipTypes, containmentEdgeTypes],
  )

  return { stageBuildRows }
}
