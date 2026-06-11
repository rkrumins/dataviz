/**
 * stageEdge — the single staging path for RAW edge authoring (create / delete /
 * reverse / retype / property edit). Plain functions over the stores (no hooks)
 * shared by the authoring controller, the edge edit panel and the context menu.
 *
 * Semantics:
 * - Aggregated and containment edges are never authorable (defense in depth —
 *   the UI also hides these actions); functions return false/null on refusal.
 * - Edits on a staged-as-create edge fold into the create change; retype of a
 *   staged reverse/retype mutates that change in place. Apply hooks read their
 *   LATEST `after` from the store so folded edits persist on save.
 * - Reverse and retype swap the canvas edge under a NEW id so their
 *   delete+create ops never target the same entity id in one commit.
 */
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { generateId } from '@/lib/utils'
import { patchEdge, deleteEdge as apiDeleteEdge } from '@/services/edgeApi'

type EdgeData = NonNullable<LineageEdge['data']>

const findEdge = (edgeId: string): LineageEdge | undefined =>
  useCanvasStore.getState().edges.find((e) => e.id === edgeId)

const edgeLabel = (edge: LineageEdge): string => {
  const nodes = useCanvasStore.getState().nodes
  const name = (id: string) => (nodes.find((n) => n.id === id)?.data.label as string) ?? id
  return `'${name(edge.source)}' → '${name(edge.target)}'`
}

/** Aggregated/containment edges are never user-authorable. */
const isAuthorable = (edge: LineageEdge): boolean =>
  !edge.data?.isAggregated && edge.type !== 'containment'

/** The staged change that *creates* this canvas edge, if any (create/reverse/retype). */
const findEdgeCreatingChange = (edgeId: string): StagedChange | undefined =>
  useStagedChangesStore.getState().changes.find(
    (c) => (c.type === 'create_edge' || c.type === 'reverse_edge' || c.type === 'retype_edge')
      && c.targetId === edgeId,
  )

type CreateEdgeAfter = {
  edgeType: string
  source: string
  target: string
  properties?: Record<string, unknown>
}

/**
 * Stage a new RAW edge between two nodes: optimistic canvas edge + a
 * `create_edge` change. In a draft, save routes it through `/graph/changes`;
 * the apply hook is the main-mode parity path (`provider.createEdge`).
 * Returns the optimistic edge id.
 */
export function stageEdgeCreate(sourceUrn: string, targetUrn: string, edgeType: string): string {
  const tempId = generateId('staged-edge')
  useCanvasStore.getState().addEdges([{
    id: tempId,
    source: sourceUrn,
    target: targetUrn,
    type: 'lineage',
    data: { edgeType, relationship: edgeType.toLowerCase() },
  }])
  const after: CreateEdgeAfter = { edgeType, source: sourceUrn, target: targetUrn }
  useStagedChangesStore.getState().stage({
    type: 'create_edge',
    targetId: tempId,
    // `source`/`target` are canvas node ids (== urns == backend entity_ids).
    after,
    summary: `Create ${edgeType} edge ${sourceUrn} → ${targetUrn}`,
    apply: async ({ provider, resolveTempId }) => {
      if (!provider) return // local-only (no backend) — accept optimistically
      // Folded edits (retype, properties) live in the change's latest `after`.
      const latest = (findEdgeCreatingChange(tempId)?.after as CreateEdgeAfter | undefined) ?? after
      const src = resolveTempId(latest.source) ?? latest.source
      const tgt = resolveTempId(latest.target) ?? latest.target
      const res = await provider.createEdge({
        sourceUrn: src, targetUrn: tgt, edgeType: latest.edgeType,
        ...(latest.properties ? { properties: latest.properties } : {}),
      })
      if (!res.success) throw new Error(res.error || 'Failed to create edge')
    },
    discard: () => useCanvasStore.getState().removeEdge(tempId),
  })
  return tempId
}

/**
 * Stage an edge deletion. A staged-as-create edge just discards its create; a
 * staged reverse/retype is unwound first (restoring the original edge) and the
 * ORIGINAL edge is then deleted. Returns false when the edge is not authorable.
 */
export function stageEdgeDelete(edgeId: string): boolean {
  const edge = findEdge(edgeId)
  if (!edge) return false
  if (!isAuthorable(edge)) return false

  const store = useStagedChangesStore.getState()
  const creating = findEdgeCreatingChange(edgeId)
  if (creating) {
    if (creating.type === 'create_edge') {
      store.discard(creating.id)
      return true
    }
    // reverse/retype: discarding restores the original edge — delete THAT one.
    const originalId = String(((creating.before as { edge?: LineageEdge })?.edge)?.id ?? '')
    store.discard(creating.id)
    return originalId ? stageEdgeDelete(originalId) : true
  }

  const snapshot = { ...edge }
  useCanvasStore.getState().removeEdge(edgeId)
  store.stage({
    type: 'delete_edge',
    targetId: edgeId,
    before: { edge: snapshot },
    after: null,
    summary: `Delete edge ${edgeLabel(edge)}`,
    apply: async ({ wsId }) => {
      await apiDeleteEdge(wsId, edgeId)
    },
    discard: () => {
      useCanvasStore.getState().addEdges([snapshot])
    },
  })
  return true
}

/**
 * Stage an edge reversal: the canvas edge is swapped for one with flipped
 * endpoints under a new id; on save the original is deleted and the flipped
 * edge created in the same atomic commit.
 */
export function stageEdgeReverse(edgeId: string): boolean {
  const edge = findEdge(edgeId)
  if (!edge) return false
  if (!isAuthorable(edge)) return false

  const reversedId = `${edgeId}-reversed`
  const reversed: LineageEdge = { ...edge, id: reversedId, source: edge.target, target: edge.source }
  useCanvasStore.getState().removeEdge(edgeId)
  useCanvasStore.getState().addEdges([reversed])

  useStagedChangesStore.getState().stage({
    type: 'reverse_edge',
    targetId: reversedId,
    before: { edge: { ...edge } },
    after: { edge: reversed },
    summary: `Reverse edge ${edgeLabel(edge)}`,
    apply: async ({ provider, wsId, resolveTempId }) => {
      if (!provider) return
      const latest = (findEdgeCreatingChange(reversedId)?.after as { edge?: LineageEdge })?.edge ?? reversed
      await apiDeleteEdge(wsId, edgeId)
      const res = await provider.createEdge({
        sourceUrn: resolveTempId(latest.source) ?? latest.source,
        targetUrn: resolveTempId(latest.target) ?? latest.target,
        edgeType: String(latest.data?.edgeType ?? edge.data?.edgeType ?? ''),
      })
      if (!res.success) throw new Error(res.error || 'Failed to reverse edge')
    },
    discard: () => {
      useCanvasStore.getState().removeEdge(reversedId)
      useCanvasStore.getState().addEdges([{ ...edge }])
    },
  })
  return true
}

/**
 * Stage an edge retype (ontology-validated upstream by `retypeOptions`):
 * the canvas edge is swapped for one with the new type under a new id; on save
 * the original is deleted and the retyped edge created in one atomic commit.
 * Retyping a staged-as-create/reverse/retype edge mutates that change instead.
 * Returns the (possibly new) canvas edge id, or null when not authorable.
 */
export function stageEdgeRetype(edgeId: string, newEdgeType: string): string | null {
  const edge = findEdge(edgeId)
  if (!edge) return null
  if (!isAuthorable(edge)) return null

  const store = useStagedChangesStore.getState()
  const newData: Partial<EdgeData> = { edgeType: newEdgeType, relationship: newEdgeType.toLowerCase() }

  const creating = findEdgeCreatingChange(edgeId)
  if (creating) {
    useCanvasStore.getState().updateEdge(edgeId, newData)
    if (creating.type === 'create_edge') {
      const prev = creating.after as CreateEdgeAfter
      store.stageOrReplace((c) => c.id === creating.id, {
        type: 'create_edge',
        targetId: creating.targetId,
        after: { ...prev, edgeType: newEdgeType },
        summary: `Create ${newEdgeType} edge ${prev.source} → ${prev.target}`,
        // hooks omitted → preserved; create's apply reads the latest after.
      })
    } else {
      // reverse_edge / retype_edge both carry the new edge in after.edge —
      // its data drives the create op's edgeType.
      const prevEdge = (creating.after as { edge: LineageEdge }).edge
      const nextEdge: LineageEdge = { ...prevEdge, data: { ...prevEdge.data, ...newData } }
      store.stageOrReplace((c) => c.id === creating.id, {
        type: creating.type,
        targetId: creating.targetId,
        after: { edge: nextEdge },
        summary: creating.type === 'retype_edge'
          ? `Change edge type to ${newEdgeType} (${edgeLabel(nextEdge)})`
          : creating.summary,
      })
    }
    return edgeId
  }

  const retypedId = `${edgeId}-retyped`
  const snapshot = { ...edge }
  const retyped: LineageEdge = { ...edge, id: retypedId, data: { ...edge.data, ...newData } }
  useCanvasStore.getState().removeEdge(edgeId)
  useCanvasStore.getState().addEdges([retyped])

  store.stage({
    type: 'retype_edge',
    targetId: retypedId,
    before: { edge: snapshot },
    after: { edge: retyped },
    summary: `Change edge type ${String(edge.data?.edgeType)} → ${newEdgeType} (${edgeLabel(edge)})`,
    apply: async ({ provider, wsId, resolveTempId }) => {
      if (!provider) return
      const latest = (findEdgeCreatingChange(retypedId)?.after as { edge?: LineageEdge })?.edge ?? retyped
      await apiDeleteEdge(wsId, edgeId)
      const res = await provider.createEdge({
        sourceUrn: resolveTempId(latest.source) ?? latest.source,
        targetUrn: resolveTempId(latest.target) ?? latest.target,
        edgeType: String(latest.data?.edgeType ?? newEdgeType),
      })
      if (!res.success) throw new Error(res.error || 'Failed to retype edge')
    },
    discard: () => {
      useCanvasStore.getState().removeEdge(retypedId)
      useCanvasStore.getState().addEdges([snapshot])
    },
  })
  return retypedId
}

/**
 * Stage an edge property edit (confidence, label, custom properties — never
 * the type; that's `stageEdgeRetype`). Successive edits merge into one
 * `edit_edge` change; edits on a staged-as-create edge fold into the create.
 */
export function stageEdgePropertyEdit(edgeId: string, updates: Record<string, unknown>): boolean {
  const edge = findEdge(edgeId)
  if (!edge) return false
  if (!isAuthorable(edge)) return false

  const store = useStagedChangesStore.getState()
  const previousData = { ...(edge.data ?? {}) } as Record<string, unknown>
  useCanvasStore.getState().updateEdge(edgeId, updates as Partial<EdgeData>)

  const creating = findEdgeCreatingChange(edgeId)
  if (creating && creating.type === 'create_edge') {
    const prev = creating.after as CreateEdgeAfter
    store.stageOrReplace((c) => c.id === creating.id, {
      type: 'create_edge',
      targetId: creating.targetId,
      after: { ...prev, properties: { ...prev.properties, ...updates } },
      summary: creating.summary,
    })
    return true
  }

  const matcher = (c: StagedChange) => c.type === 'edit_edge' && c.targetId === edgeId
  const existing = store.changes.find(matcher)
  const mergedAfter = { ...(existing?.after as Record<string, unknown> | undefined), ...updates }

  store.stageOrReplace(matcher, {
    type: 'edit_edge',
    targetId: edgeId,
    before: previousData, // ignored on replace — the original is preserved
    after: mergedAfter,
    summary: `Edit edge ${edgeLabel(edge)}`,
    discard: () => {
      const self = useStagedChangesStore.getState().changes.find(matcher)
      const original = (self?.before as Record<string, unknown> | undefined) ?? previousData
      useCanvasStore.getState().updateEdge(edgeId, original as Partial<EdgeData>)
    },
    apply: async ({ wsId }) => {
      const latest = (useStagedChangesStore.getState().changes.find(matcher)?.after
        ?? mergedAfter) as Record<string, unknown>
      await patchEdge(wsId, edgeId, latest)
    },
  })
  return true
}
