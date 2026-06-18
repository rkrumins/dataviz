/**
 * useReparentNode — drag-to-reparent on the Context View. Dropping entity A onto node B
 * nests A under B by restaging containment: it removes A's current containment edge and
 * adds a new ontology-typed one (B→A), all reviewed-before-save like every other edit.
 *
 * Guards (fail with a clear toast, never a silent illegal move):
 *   • no self-drop, and no dropping a node into one of its own descendants (cycle);
 *   • the new parent's type must be allowed to contain the child's type (ontology);
 *   • a containment relationship must exist for parent→child (forward orientation, since
 *     the new edge is stored parent→child and the backend validates it that way);
 *   • an UNSAVED (just-created) node can't be moved yet — its parent is fixed by its
 *     staged create — so we ask the user to save first.
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
import { allowedChildTypeIds, isContainmentRelType } from '@/services/ontologyPreflightService'

const endpointOk = (t: string | undefined, allowed: string[] | undefined): boolean =>
  !t || !allowed?.length || allowed.includes('*') || allowed.includes(t)

export function useReparentNode() {
  const { showToast } = useToast()
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()

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

    const isContainment = (e: LineageEdge) => isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)

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
    if (!allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap).has(childType)) {
      showToast('error', `A ${parentType} can't contain a ${childType}.`)
      return
    }

    // Forward-orientation containment relationship (the new edge is stored parent→child).
    const fwd = relationshipTypes.find((rt) =>
      isContainmentRelType(rt, containmentEdgeTypes) &&
      endpointOk(parentType, rt.sourceTypes) && endpointOk(childType, rt.targetTypes),
    )
    const containmentType = fwd?.id ?? containmentEdgeTypes[0]
    if (!containmentType) {
      showToast('error', 'No containment relationship is allowed between these entities.')
      return
    }

    const canvas = useCanvasStore.getState()
    const staged = useStagedChangesStore.getState()

    // Remove the current containment edge (if any) — optimistically + as a staged delete.
    const oldEdge = edges.find((e) => e.target === childKey && isContainment(e))
    // Un-nesting only persists inside a draft: main-mode applyAll drops the hookless
    // delete (there is no provider edge-delete), which would leave a DOUBLE parent on
    // the server (old edge kept + new edge added). Require a draft for such a move.
    if (oldEdge && !useBranchStore.getState().currentBranchId) {
      showToast('info', 'Switch to a draft to move an entity to a different parent.')
      return
    }
    if (oldEdge) {
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

    // Add the new containment edge (optimistic, marked pending so collapse never drops it).
    const tempId = generateId('staged-edge')
    const newEdge: LineageEdge = {
      id: tempId, source: parentKey, target: childKey, type: 'containment',
      data: { edgeType: containmentType, relationship: containmentType.toLowerCase(), isPending: 'create' },
    }
    canvas.addEdges([newEdge])
    staged.stage({
      type: 'create_edge',
      targetId: tempId,
      after: { edgeType: containmentType, source: parentKey, target: childKey },
      summary: `Move under ${(newParent.data?.label as string) || parentKey} (${containmentType})`,
      apply: async ({ provider, resolveTempId }) => {
        if (!provider) return
        const src = resolveTempId(parentKey) ?? parentKey
        const tgt = resolveTempId(childKey) ?? childKey
        const res = await provider.createEdge({ sourceUrn: src, targetUrn: tgt, edgeType: containmentType })
        if (!res.success) throw new Error(res.error || 'Failed to move entity')
      },
      discard: () => canvas.removeEdge(tempId),
    })

    showToast('success', `Moved under ${(newParent.data?.label as string) || parentKey}.`)
  }, [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, showToast])

  return { reparent }
}
