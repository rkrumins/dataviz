/**
 * useReparentNode — restage a node's containment so it lands under a different
 * parent (drag-to-reparent on the Context View, or "Move to…" in the entity
 * drawer) or keeps the same parent under a different relationship type ("Part of"
 * type switch in the drawer). Both restage containment the same way every other
 * edit is: remove the current containment edge and add a new ontology-typed one,
 * reviewed-before-save.
 *
 * Guards (fail with a clear toast, never a silent illegal move):
 *   • no self-drop, and no dropping a node into one of its own descendants (cycle);
 *   • the new parent's type must be allowed to contain the child's type (ontology);
 *   • a containment relationship must exist for parent→child (forward orientation, since
 *     the new edge is stored parent→child and the backend validates it that way);
 *   • an UNSAVED (just-created) node can't be moved yet — its parent is fixed by its
 *     staged create — so we ask the user to save first.
 *   • re-typing/moving REMOVES an existing parent edge, which only persists inside a
 *     draft (main-mode applyAll drops the hookless delete → double parent), so we
 *     gate those on an active draft with an 'info' toast.
 */
import { useCallback } from 'react'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useToast } from '@/components/ui/toast'
import { generateId } from '@/lib/utils'
import {
  useEntityTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
  useRelationshipTypes,
  useContainmentEdgeTypes,
  normalizeEdgeType,
  isContainmentEdgeType,
} from '@/store/schema'
import { allowedChildTypeIds, setHasId, isContainmentRelType, deriveContainmentEdges, endpointOk } from '@/services/ontologyPreflightService'

export function useReparentNode() {
  const { showToast } = useToast()
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()

  const isContainment = useCallback(
    (e: LineageEdge) => isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes),
    [containmentEdgeTypes],
  )

  // Shared restage: remove the child's current containment edge (if any) and add a
  // new parent→child one of `containmentType`, optimistically + as staged changes.
  // Assumes the caller has already validated ontology / cycle / draft gating.
  const restageContainment = useCallback(
    (childKey: string, parentKey: string, parentLabel: string, containmentType: string) => {
      const canvas = useCanvasStore.getState()
      const staged = useStagedChangesStore.getState()
      const { edges } = canvas
      const oldEdge = edges.find((e) => e.target === childKey && isContainment(e))

      if (oldEdge) {
        // If the current containment edge is itself an UNSAVED staged create from an
        // earlier restage this session, collapse it: discard that staged create (its
        // discard hook removes the canvas edge) instead of staging a delete of a temp
        // id — the backend can't match a temp-id delete, so it would NOT cancel the
        // earlier create and we'd persist a DUPLICATE (double-parent) edge. Only a
        // REAL (already-saved) edge gets a delete_edge.
        const priorStagedCreate = staged.changes.find(
          (c) => c.type === 'create_edge' && c.targetId === oldEdge.id,
        )
        if (priorStagedCreate) {
          staged.discard(priorStagedCreate.id)   // removes the staged create + its optimistic edge
        } else {
          canvas.removeEdge(oldEdge.id)
          // No apply hook (mirrors the existing delete-edge flow): in DRAFT mode the
          // delete is folded into /graph/changes via stagedChangesToOps; there is no
          // provider edge-delete method for main mode.
          staged.stage({
            type: 'delete_edge',
            targetId: oldEdge.id,
            before: { edge: { id: oldEdge.id, source: oldEdge.source, target: oldEdge.target, edgeType: oldEdge.data?.edgeType } },
            after: null,
            summary: `Unnest from ${oldEdge.source}`,
            discard: () => canvas.addEdges([oldEdge]),
          })
        }
      }

      // Add the new containment edge (optimistic, marked pending so collapse never drops it).
      const tempId = generateId('staged-edge')
      const newEdge: LineageEdge = {
        id: tempId, source: parentKey, target: childKey, type: 'containment',
        data: { edgeType: containmentType, relationship: containmentType.toLowerCase(), isPending: 'create' },
      }
      canvas.addEdges([newEdge])
      useStagedChangesStore.getState().stage({
        type: 'create_edge',
        targetId: tempId,
        after: { edgeType: containmentType, source: parentKey, target: childKey },
        summary: `Move under ${parentLabel} (${containmentType})`,
        apply: async ({ provider, resolveTempId }) => {
          if (!provider) return
          const src = resolveTempId(parentKey) ?? parentKey
          const tgt = resolveTempId(childKey) ?? childKey
          const res = await provider.createEdge({ sourceUrn: src, targetUrn: tgt, edgeType: containmentType })
          if (!res.success) throw new Error(res.error || 'Failed to move entity')
        },
        discard: () => canvas.removeEdge(tempId),
      })
    },
    [isContainment],
  )

  const reparent = useCallback((draggedId: string, newParentId: string) => {
    if (!draggedId || !newParentId || draggedId === newParentId) return
    const { nodes, edges } = useCanvasStore.getState()
    const dragged = nodes.find((n) => n.id === draggedId || (n.data?.urn as string) === draggedId)
    const newParent = nodes.find((n) => n.id === newParentId || (n.data?.urn as string) === newParentId)
    if (!dragged || !newParent) return
    const childKey = dragged.id
    const parentKey = newParent.id
    if (childKey === parentKey) return

    if (dragged.data?.isPending === 'create') {
      showToast('info', 'Save this new entity before moving it to a different parent.')
      return
    }

    // Containment topology (for cycle detection + finding the current parent edge).
    const childrenOf = new Map<string, string[]>()
    const parentOf = new Map<string, string>()
    for (const e of edges) {
      if (!e.source || !e.target || !isContainment(e)) continue
      parentOf.set(e.target, e.source)
      const arr = childrenOf.get(e.source)
      if (arr) arr.push(e.target)
      else childrenOf.set(e.source, [e.target])
    }

    // Cycle guard: the new parent must not be the node itself or any of its descendants.
    const descendants = new Set<string>()
    const stack = [childKey]
    while (stack.length) {
      const id = stack.pop()!
      for (const c of childrenOf.get(id) ?? []) {
        if (!descendants.has(c)) { descendants.add(c); stack.push(c) }
      }
    }
    if (descendants.has(parentKey)) {
      showToast('error', "Can't move an entity inside one of its own descendants.")
      return
    }
    if (parentOf.get(childKey) === parentKey) return  // already there — no-op

    const childType = dragged.data?.type as string
    const parentType = newParent.data?.type as string
    if (!setHasId(allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap), childType)) {
      showToast('error', `A ${parentType} can't contain a ${childType}.`)
      return
    }

    // Forward-orientation containment relationship (the new edge is stored parent→child). No
    // fallback to containmentEdgeTypes[0]: if no relationship type's endpoint constraints admit
    // this exact parent→child pair, the move is ontology-invalid — abort rather than stage an
    // edge the backend would reject.
    const fwd = relationshipTypes.find((rt) =>
      isContainmentRelType(rt, containmentEdgeTypes) &&
      endpointOk(parentType, rt.sourceTypes) && endpointOk(childType, rt.targetTypes),
    )
    const containmentType = fwd?.id
    if (!containmentType) {
      showToast('error', 'No containment relationship is allowed between these entities.')
      return
    }

    // Un-nesting only persists inside a draft: main-mode applyAll drops the hookless
    // delete (there is no provider edge-delete), which would leave a DOUBLE parent on
    // the server (old edge kept + new edge added). Require a draft for such a move.
    const oldEdge = edges.find((e) => e.target === childKey && isContainment(e))
    if (oldEdge && !useBranchStore.getState().currentBranchId) {
      showToast('info', 'Switch to a draft to move an entity to a different parent.')
      return
    }

    restageContainment(childKey, parentKey, (newParent.data?.label as string) || parentKey, containmentType)
    showToast('success', `Moved under ${(newParent.data?.label as string) || parentKey}.`)
  }, [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, showToast, isContainment, restageContainment])

  // retypeContainment — keep the SAME parent, switch the containment relationship
  // TYPE. The backend edge_type is immutable, so this is a delete-old + create-new
  // (NOT an update). No-op when the type is unchanged.
  const retypeContainment = useCallback((childId: string, newEdgeType: string) => {
    if (!childId || !newEdgeType) return
    const { nodes, edges } = useCanvasStore.getState()
    const child = nodes.find((n) => n.id === childId || (n.data?.urn as string) === childId)
    if (!child) return
    const childKey = child.id

    if (child.data?.isPending === 'create') {
      showToast('info', 'Save this new entity before changing how it relates to its parent.')
      return
    }

    const oldEdge = edges.find((e) => e.target === childKey && isContainment(e))
    if (!oldEdge) {
      showToast('info', "This entity has no parent yet, so there's no relationship to change.")
      return
    }
    if (normalizeEdgeType(oldEdge) === newEdgeType.toUpperCase()) return  // unchanged — no-op

    const parentKey = oldEdge.source
    const parent = nodes.find((n) => n.id === parentKey)
    const childType = child.data?.type as string
    const parentType = parent?.data?.type as string

    // Validate the requested type is an ALLOWED containment option for this pair.
    const allowed = deriveContainmentEdges(parentType, childType, relationshipTypes, containmentEdgeTypes)
      .filter((o) => o.allowed)
    if (!allowed.some((o) => o.edgeType === newEdgeType)) {
      showToast('error', "That relationship isn't allowed between these entities.")
      return
    }

    // Switching the type removes the old edge, which only persists inside a draft.
    if (!useBranchStore.getState().currentBranchId) {
      showToast('info', 'Switch to a draft to change how this entity relates to its parent.')
      return
    }

    restageContainment(childKey, parentKey, (parent?.data?.label as string) || parentKey, newEdgeType)
    showToast('success', 'Relationship updated.')
  }, [relationshipTypes, containmentEdgeTypes, showToast, isContainment, restageContainment])

  return { reparent, retypeContainment }
}
