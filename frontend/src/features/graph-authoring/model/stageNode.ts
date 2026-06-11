/**
 * stageNode — the single staging path for node authoring (create / update /
 * delete). Plain functions over the stores (no hooks) so the authoring
 * controller, panels and composer all share exactly one implementation, and
 * the behavior is unit-testable without React.
 *
 * Semantics:
 * - Every action mutates the canvas optimistically and stages ONE reviewable
 *   change per node (successive edits merge; edits on a staged-as-create node
 *   fold into the create).
 * - Create apply hooks read their LATEST `after` from the store at apply time
 *   (not their creation-time closure) so folded edits persist on save.
 * - Discarding a parent create recursively discards the creates that depend on
 *   its temp urn — a composer subtree disappears as a unit.
 */
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { getDeleteImpact } from '@/services/versioningApiService'
import { generateId } from '@/lib/utils'

export interface StageEntityCreateInput {
  entityType: string
  displayName: string
  /** Parent node urn for nested creation (may be another staged node's temp urn). */
  parentUrn?: string | null
  tags?: string[]
  /** Free-form properties (description, custom schema fields, etc.). */
  properties?: Record<string, unknown>
}

type CreateAfter = {
  entityType: string
  displayName: string
  parentUrn?: string
  tags: string[]
  properties: Record<string, unknown>
}

const findCreateChange = (nodeId: string): StagedChange | undefined =>
  useStagedChangesStore.getState().changes.find(
    (c) => c.type === 'create_entity' && c.targetId === nodeId,
  )

/** Recursively discard staged creates whose parentUrn points at `tempUrn`. */
function discardDependentCreates(tempUrn: string): void {
  const store = useStagedChangesStore.getState()
  const dependents = store.changes.filter(
    (c) => c.type === 'create_entity' && (c.after as CreateAfter | undefined)?.parentUrn === tempUrn,
  )
  // Each child's own discard hook removes its node/edge and recurses further.
  dependents.forEach((c) => useStagedChangesStore.getState().discard(c.id))
}

/**
 * Stage a new entity: optimistic pending node (+ containment edge when the
 * parent is a node already on the canvas) and a `create_entity` change whose
 * apply hook runs the branch-scoped `provider.createNode`. Returns the
 * optimistic temp urn.
 */
export function stageEntityCreate(input: StageEntityCreateInput): string {
  const canvas = useCanvasStore.getState()
  const tags = input.tags ?? []
  const properties = input.properties ?? {}

  // Only treat the parent as a CONTAINMENT parent when it's a real node on the
  // canvas (a just-staged node counts — it's in the store). A layer id or a
  // not-yet-loaded container would otherwise produce a dangling containment
  // edge, orphaning the new node in the hierarchy. When the parent isn't a
  // node, create at the root and let layer assignment place it.
  const parentUrnRaw = input.parentUrn || undefined
  const parentIsNode = parentUrnRaw
    ? canvas.nodes.some((n) => n.id === parentUrnRaw || (n.data?.urn as string) === parentUrnRaw)
    : false
  const parentUrn = parentIsNode ? parentUrnRaw : undefined

  const tempUrn = `urn:staged:${input.entityType}:${generateId('new')}`
  const containmentEdgeId = parentUrn ? `contains-${parentUrn}-${tempUrn}` : null
  const containmentEdgeType =
    useSchemaStore.getState().schema?.containmentEdgeTypes?.[0] ?? 'CONTAINS'

  canvas.addNodes([{
    id: tempUrn,
    type: 'generic',
    position: { x: 0, y: 0 },
    data: {
      label: input.displayName,
      type: input.entityType,
      urn: tempUrn,
      classifications: tags,
      isPending: 'create',
      properties,
    },
  }])

  if (containmentEdgeId && parentUrn) {
    canvas.addEdges([{
      id: containmentEdgeId,
      source: parentUrn,
      target: tempUrn,
      type: 'containment',
      data: { edgeType: containmentEdgeType, relationship: containmentEdgeType.toLowerCase() },
    }])
  }

  const after: CreateAfter = { entityType: input.entityType, displayName: input.displayName, parentUrn, tags, properties }

  useStagedChangesStore.getState().stage({
    type: 'create_entity',
    targetId: tempUrn,
    targetUrn: tempUrn,
    after,
    summary: `Create ${input.entityType}: '${input.displayName}'`,
    apply: async ({ provider, registerTempIdResolution, resolveTempId }) => {
      // Read the LATEST staged values — renames/property edits made after the
      // create fold into this change's `after` (see stageNodeUpdate).
      const latest = (findCreateChange(tempUrn)?.after as CreateAfter | undefined) ?? after
      if (!provider) {
        // No provider — accept the local-only creation by clearing the pending flag.
        useCanvasStore.getState().updateNode(tempUrn, { isPending: undefined })
        return
      }
      // Resolve a staged parent's temp urn to its real urn (set when the
      // parent's own create_entity applied earlier in this save).
      const resolvedParent = latest.parentUrn ? (resolveTempId(latest.parentUrn) ?? latest.parentUrn) : undefined
      const result = await provider.createNode({
        entityType: latest.entityType as never,
        displayName: latest.displayName,
        parentUrn: resolvedParent,
        properties: latest.properties,
        tags: latest.tags,
      })
      if (!result.success || !result.node) {
        throw new Error(result.error || 'Failed to create entity')
      }
      registerTempIdResolution(tempUrn, result.node.urn)
      // Swap the optimistic temp node for the backend-issued one.
      useCanvasStore.getState().removeNode(tempUrn)
      if (containmentEdgeId) useCanvasStore.getState().removeEdge(containmentEdgeId)
      useCanvasStore.getState().addNodes([{
        id: result.node.urn,
        type: 'generic',
        position: { x: 0, y: 0 },
        data: {
          label: result.node.displayName,
          type: result.node.entityType,
          urn: result.node.urn,
          classifications: result.node.tags,
          properties: result.node.properties,
        },
      }])
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
      // A composer subtree (or any child created under this temp urn) cannot
      // outlive its parent — discard dependents first, then this node.
      discardDependentCreates(tempUrn)
      if (containmentEdgeId) useCanvasStore.getState().removeEdge(containmentEdgeId)
      useCanvasStore.getState().removeNode(tempUrn)
    },
  })

  return tempUrn
}

/**
 * Stage an update to a node's canvas data (label, properties, classifications…).
 * Successive edits merge into ONE staged change with the original `before`
 * preserved; edits on a staged-as-create node fold into the create change.
 */
export function stageNodeUpdate(nodeId: string, updates: Record<string, unknown>): void {
  const canvas = useCanvasStore.getState()
  const node = canvas.nodes.find((n) => n.id === nodeId)
  if (!node) return

  const previousData = { ...(node.data as Record<string, unknown>) }
  const changedKeys = Object.keys(updates).filter(
    (k) => JSON.stringify(previousData[k]) !== JSON.stringify(updates[k]),
  )
  if (changedKeys.length === 0) return

  canvas.updateNode(nodeId, updates)
  const store = useStagedChangesStore.getState()

  // Staged-as-create → fold into the create's `after` (apply reads it live).
  const createChange = findCreateChange(nodeId)
  if (createChange) {
    const prev = createChange.after as CreateAfter
    const merged: CreateAfter = {
      ...prev,
      displayName: (updates.label as string) ?? prev.displayName,
      properties: (updates.properties as Record<string, unknown>) ?? prev.properties,
      tags: (updates.classifications as string[]) ?? prev.tags,
    }
    store.stageOrReplace(
      (c) => c.id === createChange.id,
      {
        type: 'create_entity',
        targetId: createChange.targetId,
        targetUrn: createChange.targetUrn,
        after: merged,
        summary: `Create ${merged.entityType}: '${merged.displayName}'`,
        // apply/discard omitted → stageOrReplace keeps the create's own hooks.
      },
    )
    return
  }

  const matcher = (c: StagedChange) =>
    (c.type === 'update_entity' || c.type === 'rename_entity') && c.targetId === nodeId
  const existing = store.changes.find(matcher)
  const mergedAfter = { ...(existing?.after as Record<string, unknown> | undefined), ...updates }
  const baseline = (existing?.before as Record<string, unknown> | undefined) ?? previousData
  const label = (baseline.label as string) ?? nodeId
  const fieldNames = Object.keys(mergedAfter).filter(
    (k) => JSON.stringify(baseline[k]) !== JSON.stringify(mergedAfter[k]),
  )

  store.stageOrReplace(matcher, {
    type: 'update_entity',
    targetId: nodeId,
    targetUrn: (previousData.urn as string) ?? nodeId,
    before: previousData, // ignored on replace — stageOrReplace preserves the original
    after: mergedAfter,
    summary: `Update '${label}': ${fieldNames.join(', ') || 'no changes'}`,
    discard: () => {
      // Restore from the change's own `before` (the ORIGINAL state, which a
      // later merge must not overwrite — this hook may be the replaced one).
      const self = useStagedChangesStore.getState().changes.find(matcher)
      const original = (self?.before as Record<string, unknown> | undefined) ?? previousData
      useCanvasStore.getState().updateNode(nodeId, original)
    },
    apply: async () => {
      // Draft saves route update_entity through /graph/changes; in main mode
      // there is no node PATCH endpoint yet, so the edit stays local-only.
      console.warn('[update_entity] main-mode node PATCH not yet implemented', { nodeId })
    },
  })
}

export interface StageNodeDeleteOptions {
  onDeleted?: (nodeId: string) => void
}

interface DeleteCascade {
  nodes: unknown[]
  edges: unknown[]
  nodeTotal: number
  edgeTotal: number
  descUrns: string[]
}

/**
 * Stage a node deletion. A staged-as-create node just discards its create
 * (recursively discarding dependents); a real node is marked pending-delete and
 * a `delete_entity` is staged with the backend's cascade impact preview when a
 * draft branch is available.
 */
export function stageNodeDelete(nodeId: string, options: StageNodeDeleteOptions = {}): void {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
  if (!node) return

  const store = useStagedChangesStore.getState()
  const createChange = findCreateChange(nodeId)
  if (createChange) {
    store.discard(createChange.id)
    options.onDeleted?.(nodeId)
    return
  }

  const urn = (node.data?.urn as string) ?? nodeId
  const label = (node.data?.label as string) ?? nodeId
  // Mark visually as pending-delete; actual removal happens on Save.
  useCanvasStore.getState().updateNode(nodeId, { isPending: 'delete' })

  // Stage the (single) root delete. The backend cascades the containment
  // subtree + all incident edges authoritatively; `cascade` (from the
  // delete-impact preview) lets the review panel itemise what will be removed.
  const stageDelete = (cascade?: DeleteCascade) => {
    const more = cascade && (cascade.nodeTotal > 1 || cascade.edgeTotal > 0)
    const summary = more
      ? `Delete '${label}' — also removes ${cascade.nodeTotal - 1} contained `
        + `${cascade.nodeTotal === 2 ? 'entity' : 'entities'}, `
        + `${cascade.edgeTotal} relationship${cascade.edgeTotal === 1 ? '' : 's'}`
      : `Delete '${label}'`
    useStagedChangesStore.getState().stage({
      type: 'delete_entity',
      targetId: nodeId,
      targetUrn: urn,
      before: {
        node: { ...node },
        cascade: cascade
          ? { nodes: cascade.nodes, edges: cascade.edges, nodeTotal: cascade.nodeTotal, edgeTotal: cascade.edgeTotal }
          : undefined,
      },
      after: null,
      summary,
      apply: async () => {
        useCanvasStore.getState().removeNode(nodeId)
      },
      discard: () => {
        useCanvasStore.getState().updateNode(nodeId, { isPending: undefined })
        cascade?.descUrns.forEach((id) => useCanvasStore.getState().updateNode(id, { isPending: undefined }))
      },
    })
    options.onDeleted?.(nodeId)
  }

  // In a draft, fetch the cascade impact on demand (the canvas is lazy-loaded,
  // so only the backend knows the full subtree). Mark loaded descendants
  // pending-delete so the user sees the impact immediately.
  const bs = useBranchStore.getState()
  if (bs.currentBranchId && bs.graphId && bs.dataSourceId && bs.workspaceId) {
    getDeleteImpact(bs.workspaceId, bs.dataSourceId, bs.currentBranchId, urn)
      .then((impact) => {
        const descUrns = impact.nodes
          .map((n) => String((n as { urn?: unknown; entityId?: unknown }).urn ?? (n as { entityId?: unknown }).entityId ?? ''))
          .filter((id) => id && id !== urn)
        descUrns.forEach((id) => useCanvasStore.getState().updateNode(id, { isPending: 'delete' }))
        stageDelete({
          nodes: impact.nodes, edges: impact.edges,
          nodeTotal: impact.nodeTotal, edgeTotal: impact.edgeTotal, descUrns,
        })
      })
      .catch(() => stageDelete()) // preview unavailable — still stage the root delete
  } else {
    stageDelete()
  }
}
