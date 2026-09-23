/**
 * useReparentNode — restage a node's containment so it lands under a different
 * parent (drag-to-reparent on the Context View, or "Move to…" in the entity
 * drawer) or keeps the same parent under a different relationship type ("Part of"
 * type switch in the drawer). Both restage containment the same way every other
 * edit is: staged for review, saved as one `move` the server resolves against what is stored.
 *
 * Guards (fail with a clear notification, never a silent illegal move):
 *   • no self-drop, and no dropping a node into one of its own descendants (cycle);
 *   • the new parent's type must be allowed to contain the child's type (ontology);
 *   • a containment relationship must exist for parent→child (forward orientation, since
 *     the new edge is stored parent→child and the backend validates it that way);
 *   • an UNSAVED (just-created) node can't be moved yet — its parent is fixed by its
 *     staged create — so we ask the user to save first.
 *   • a move is ONE server-resolved `move` op in the draft save (the backend replaces
 *     whatever parent link the node has, loaded here or not), so it needs a draft.
 */
import { useCallback } from 'react'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { layoutWriter } from '@/store/canvasLayoutBridge'
import type { MoveAfter } from '@/store/stagedOverlay'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { unassignEntities } from './assignmentMutations'
import { useAppNotifications } from '@/components/ui/notifications'
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

/** What a move replaced, for discard: the parent links the canvas showed, and the view layout. */
interface MoveBefore {
  removedLinks: LineageEdge[]
  layout: NormalizedReferenceLayout | null
}

export function useReparentNode() {
  const { notify } = useAppNotifications()
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()

  const isContainment = useCallback(
    (e: LineageEdge) => isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes),
    [containmentEdgeTypes],
  )

  // Shared restage: ONE staged `move_entity`. The server resolves it against what is STORED — it
  // removes whatever parent link the child has and adds the new one — so the move is exact even
  // when the canvas never loaded the old link (it used to delete only a LOADED link, and a node
  // whose old link was not loaded ended up under both parents). On the canvas the move is shown at
  // once: every loaded parent link of the child is removed, the new one drawn as pending, and the
  // child's own layer pin cleared so it follows its new parent (a pin from where it was created kept
  // it ALSO split out in its old column). The staged overlay keeps all of that across any reload.
  const restageContainment = useCallback(
    (childKey: string, parentKey: string, parentLabel: string, containmentType: string) => {
      const canvas = useCanvasStore.getState()
      const staged = useStagedChangesStore.getState()
      const prior = staged.changes.find(
        (c) => c.type === 'move_entity' && (c.after as MoveAfter).childId === childKey,
      )
      const priorAfter = prior?.after as MoveAfter | undefined
      const loadedLinks = canvas.edges.filter((e) => e.target === childKey && isContainment(e))
      // The state before the FIRST move of this child this session (a later move replaces the
      // earlier one, so discarding restores the true starting point).
      const writer = layoutWriter()
      const before: MoveBefore = (prior?.before as MoveBefore | undefined) ?? {
        removedLinks: loadedLinks.filter((e) => e.data?.isPending !== 'create'),
        layout: writer?.current() ?? null,
      }

      const edgeId = generateId('staged-edge')
      const newLink: LineageEdge = {
        id: edgeId, source: parentKey, target: childKey, type: 'containment',
        data: { edgeType: containmentType, relationship: containmentType.toLowerCase(), isPending: 'create' },
      }
      const after: MoveAfter = {
        childId: childKey, parentId: parentKey, edgeId, edgeType: containmentType,
        containmentTypes: containmentEdgeTypes.map((t) => t.toUpperCase()),
      }
      const show = () => {
        const cs = useCanvasStore.getState()
        for (const e of cs.edges.filter((x) => x.target === childKey && isContainment(x))) cs.removeEdge(e.id)
        cs.addEdges([newLink])
        const w = layoutWriter()
        if (w?.current().assignments[childKey]) w.persist(unassignEntities(w.current(), [childKey]))
        useReferenceModelStore.getState().removeEntityAssignment(childKey)
      }
      show()
      useStagedChangesStore.getState().stageOrReplace(
        (c) => c.type === 'move_entity' && (c.after as MoveAfter).childId === childKey,
        {
          type: 'move_entity',
          targetId: childKey,
          targetUrn: (canvas.nodes.find((n) => n.id === childKey)?.data?.urn as string) ?? childKey,
          before,
          after,
          summary: `Move under ${parentLabel}`,
          discard: () => {
            const cs = useCanvasStore.getState()
            cs.removeEdge(edgeId)
            if (priorAfter?.edgeId) cs.removeEdge(priorAfter.edgeId)
            cs.addEdges(before.removedLinks)
            if (before.layout) layoutWriter()?.persist(before.layout)
          },
          reapply: show,
        },
      )
    },
    [isContainment, containmentEdgeTypes],
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
      notify('info', 'Save this new entity before moving it to a different parent.')
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
      notify('error', "Can't move an entity inside one of its own descendants.")
      return
    }
    if (parentOf.get(childKey) === parentKey) return  // already there — no-op

    const childType = dragged.data?.type as string
    const parentType = newParent.data?.type as string
    if (!setHasId(allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap), childType)) {
      notify('error', `A ${parentType} can't contain a ${childType}.`)
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
      notify('error', 'No containment relationship is allowed between these entities.')
      return
    }

    // A move is a draft-save op (the server resolves the node's current parent), so it needs a
    // draft — whether or not the canvas has loaded the node's current parent link.
    if (!useBranchStore.getState().currentBranchId) {
      notify('info', 'Switch to a draft to move an entity to a different parent.')
      return
    }

    restageContainment(childKey, parentKey, (newParent.data?.label as string) || parentKey, containmentType)
    notify('success', `Moved under ${(newParent.data?.label as string) || parentKey}.`)
  }, [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, notify, isContainment, restageContainment])

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
      notify('info', 'Save this new entity before changing how it relates to its parent.')
      return
    }

    const oldEdge = edges.find((e) => e.target === childKey && isContainment(e))
    if (!oldEdge) {
      notify('info', "This entity has no parent yet, so there's no relationship to change.")
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
      notify('error', "That relationship isn't allowed between these entities.")
      return
    }

    // Switching the type removes the old edge, which only persists inside a draft.
    if (!useBranchStore.getState().currentBranchId) {
      notify('info', 'Switch to a draft to change how this entity relates to its parent.')
      return
    }

    restageContainment(childKey, parentKey, (parent?.data?.label as string) || parentKey, newEdgeType)
    notify('success', 'Relationship updated.')
  }, [relationshipTypes, containmentEdgeTypes, notify, isContainment, restageContainment])

  return { reparent, retypeContainment }
}
