/**
 * saveStagedChangesToDraft — the draft "Save" path, as ONE atomic commit.
 *
 * Every staged edit — creates (the backend mints the urn + resolves temp refs), user-drawn and
 * containment edges, renames/updates/deletes, AND layer moves — is translated to `/graph/changes`
 * ops and sent in a SINGLE batch, so one Review & Save lands as exactly one commit on the draft
 * (not one commit per created entity). The commit is atomic: on any failure nothing is persisted.
 *
 * After the commit succeeds there is NO reload — the canvas keeps its optimistic nodes — so we
 * reconcile it in place from the batch's ref→id map: each create swaps its temp node for the real
 * one (via its `reconcile` hook, childCount-safe), layer assignments are re-keyed temp→real, and
 * user-drawn edges are re-pointed at the real endpoints.
 */
import { applyGraphChanges, type GraphChangeOp } from '@/services/versioningApiService'
import type { StagedChange } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useCanvasStore } from '@/store/canvas'
import { stagedChangesToOps } from './stagedChangesToOps'

export interface DraftSaveTarget {
  wsId: string
  dataSourceId: string
  branchId: string
  provider: GraphDataProvider
  message?: string
  /**
   * Re-key view-config (layer) assignments from a created entity's temp urn onto its real urn,
   * so a node created in a layer keeps its column after the save reconciles.
   */
  remapEntityId?: (oldId: string, newId: string) => void
}

export async function saveStagedChangesToDraft(
  changes: StagedChange[],
  target: DraftSaveTarget,
): Promise<{ commitId?: string | null }> {
  // ── Build ONE op batch ──────────────────────────────────────────────────────────────────────
  const ops: GraphChangeOp[] = stagedChangesToOps(changes)   // creates + edges + renames/updates/deletes
  for (const c of changes) {                                 // fold layer moves into the SAME batch
    if (c.type !== 'assign_layer' && c.type !== 'move_to_layer') continue
    const layerId = (c.after as { layerId?: string } | undefined)?.layerId
    const rawId = c.targetUrn ?? c.targetId
    // Logical/pseudo groups have no backend entity. A fresh node's temp urn stays as-is and resolves
    // server-side against the batch's creates.
    if (!layerId || !rawId || rawId.startsWith('logical:')) continue
    ops.push({ op: 'update', kind: 'node', id: rawId, payload: { layerAssignment: layerId } })
  }

  if (ops.length === 0) return { commitId: null }

  // ── One atomic commit ───────────────────────────────────────────────────────────────────────
  // On any failure NOTHING is persisted (no partial state). The error propagates to the caller,
  // which surfaces it; the staged changes stay put for a clean retry.
  const res = await applyGraphChanges(target.wsId, target.dataSourceId, target.branchId, ops, target.message)
  const assigned = res.assigned ?? {}
  const resolveRef = (id: string) => assigned[id] ?? id

  // ── Reconcile the optimistic canvas in place (no post-save reload) ────────────────────────────
  // Capture user-drawn edges BEFORE the create swaps: canvas.removeNode CASCADES (drops every edge
  // touching the node), so an edge between two fresh nodes would otherwise be silently dropped.
  const cs = useCanvasStore.getState()
  const userEdges = changes.flatMap((c) => {
    if (c.type !== 'create_edge') return []
    const opt = cs.edges.find((e) => e.id === c.targetId)
    return opt ? [{ c, opt }] : []
  })

  for (const c of changes) {
    // create_entity: swap the optimistic temp node for the real minted id. Cosmetic canvas surgery —
    // a glitch here must never fail an already-committed save.
    if (c.type === 'create_entity') {
      try { reconcileCreatedNode(c, resolveRef) } catch { /* noop */ }
    }
    const tempUrn = c.targetUrn
    if (tempUrn && resolveRef(tempUrn) !== tempUrn) target.remapEntityId?.(tempUrn, resolveRef(tempUrn))
  }

  // Re-add user-drawn edges with the real edge id + resolved endpoints (the swapped nodes now carry
  // their real urns).
  if (userEdges.length > 0) {
    useCanvasStore.getState().addEdges(userEdges.map(({ c, opt }) => ({
      ...opt,
      id: resolveRef(c.targetId),
      source: resolveRef(opt.source),
      target: resolveRef(opt.target),
      data: { ...opt.data, isPending: undefined },
    })))
  }

  return { commitId: res.commitId ?? null }
}

/** Swap a just-created entity's optimistic temp node for its real minted id — generic over how the
 *  create was staged (single-add via useStageEntityCreation OR build/paste via planBuildStaging;
 *  both put the same shape on `c.after`). Preserves the childCount patch so the post-save
 *  collapse→expand cycle never orphans this node's children, and re-points its containment edge at
 *  the real parent/child. `canvas.removeNode` already drops the optimistic containment edge via its
 *  cascade, so we only re-add the resolved one. Called parent-before-child (staging order), so every
 *  node re-adds its own upward edge with endpoints resolved to real ids. */
function reconcileCreatedNode(c: StagedChange, resolveRef: (id: string) => string): void {
  const tempUrn = c.targetUrn ?? c.targetId
  const realUrn = resolveRef(tempUrn)
  const cs = useCanvasStore.getState()
  const opt = cs.nodes.find((n) => n.id === tempUrn)
  const stagedChildCount = cs.edges.filter(
    (e) => e.source === tempUrn && e.type === 'containment' && e.data?.isPending === 'create',
  ).length
  cs.removeNode(tempUrn)   // cascades: drops this node's optimistic containment edges
  if (opt) {
    cs.addNodes([{
      ...opt,
      id: realUrn,
      data: {
        ...opt.data,
        urn: realUrn,
        isPending: undefined,
        childCount: Math.max((opt.data?.childCount as number) ?? 0, stagedChildCount),
      },
    }])
  }
  const after = (c.after ?? {}) as { parentUrn?: string; containmentEdgeType?: string }
  if (after.parentUrn) {
    const et = after.containmentEdgeType ?? 'CONTAINS'
    cs.addEdges([{
      id: resolveRef(`contains-${tempUrn}`),
      source: resolveRef(after.parentUrn),
      target: realUrn,
      type: 'containment',
      data: { edgeType: et, relationship: et.toLowerCase() },
    }])
  }
}
