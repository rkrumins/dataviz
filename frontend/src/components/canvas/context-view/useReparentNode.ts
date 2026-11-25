/**
 * useReparentNode — restage a node's containment so it lands under a different
 * parent (a row dropped on another, an entity dropped in the column mapped to a
 * node, "Choose a new parent…" in the entity drawer — or "On its own, at the
 * top"), or keeps the same parent under a different relationship type ("How it
 * relates" in the drawer). A move is a DATA change: staged for review, saved as
 * one `move` the server resolves against what is stored.
 *
 * `verdict` says what a drop would do without staging anything, so a drag can say
 * it before the drop: nothing (itself, or already there), a VIEW change (onto its
 * own parent while the view places it elsewhere: it goes back under it), a DATA
 * change, or refused and why. Refused with a clear notification, never a silent
 * illegal move:
 *   • where the canvas refuses graph edits — the same gates as its menus (a draft
 *     open and writable, editing on, no trace, not a view the server places); the
 *     canvas's move host says which;
 *   • into one of its own descendants (cycle);
 *   • under a parent whose type holds nothing (as its row offers no "+"), or may
 *     not contain this type (ontology), or with no
 *     containment relationship for that parent→child pair (forward orientation:
 *     the new edge is stored parent→child and the backend validates it that way);
 *   • outside a draft (a move is a draft-save op).
 *
 * An entity created in this draft has no stored parent to replace: its staged
 * create is pointed at the new parent instead (one parent link on save), and Undo
 * points it back.
 *
 * Where a moved entity is shown follows the rule a create does: placed by hand in
 * a column that holds its type, it stays there; any other placement is cleared and
 * it follows its new parent. Its old and new parents' child counts move with it,
 * and the canvas opens the new parent.
 */
import { useCallback } from 'react'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { layoutWriter, moveHost, type MoveRefusal } from '@/store/canvasLayoutBridge'
import { gatheringNodeUpdates } from '@/store/nodeUpdateBatch'
import type { MoveAfter } from '@/store/stagedOverlay'
import type { LayerAssignmentEntry } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { assignEntities, restoreAssignment, unassignEntities } from './assignmentMutations'
import { useAppNotifications } from '@/components/ui/notifications'
import { generateId } from '@/lib/utils'
import { containmentIndexOf, nodeIndexOf } from '@/lib/storeIndex'
import {
  useEntityTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
  useRelationshipTypes,
  useContainmentEdgeTypes,
  normalizeEdgeType,
  isContainmentEdgeType,
} from '@/store/schema'
import { allowedChildTypeIds, setHasId, isClosedToNesting, isContainmentRelType, deriveContainmentEdges, endpointOk } from '@/services/ontologyPreflightService'

/** What a move replaced, for discard: the parent links the canvas showed, and the moved entity's
 *  own placement in the view (null: it had none) — only that, so a layout edit made since stays. */
interface MoveBefore {
  removedLinks: LineageEdge[]
  pin: LayerAssignmentEntry | null
}

/** Where a staged create puts its entity (the rest of its `after` is the entity itself). */
interface CreateAfter {
  entityType: string
  displayName: string
  parentUrn?: string
  containmentEdgeType?: string
  parentLabel?: string
}

/** What dropping (or picking) an entity onto a new parent would do. */
export type MoveVerdict =
  /** Nothing: itself, or already there. */
  | { kind: 'none' }
  /** Already its parent while the view places it elsewhere: it is shown back under it (layout only). */
  | { kind: 'view' }
  /** A move — changes the data — under this relationship (none: to the top level). */
  | { kind: 'data'; edgeType: string | null }
  /** Refused: `hint` for a drag, `message` for the notification. */
  | { kind: 'blocked'; hint: string; message: string; tone: 'info' | 'error' }

const NONE: MoveVerdict = { kind: 'none' }
const NOT_IN_DRAFT: MoveRefusal = {
  hint: 'Open a draft to move it',
  message: 'Switch to a draft to move an entity to a different parent.',
}
const refused = (r: MoveRefusal, tone: 'info' | 'error' = 'info'): MoveVerdict => ({ kind: 'blocked', ...r, tone })

const addTo = (deltas: Map<string, number>, id: string, by: number) => deltas.set(id, (deltas.get(id) ?? 0) + by)

/** Move child counts by `deltas` (parent → change), so a column mapped to a parent never flips back
 *  to a row, nor offers a page of children that will never come, while a move is pending. */
function shiftChildCounts(deltas: ReadonlyMap<string, number>) {
  const cs = useCanvasStore.getState()
  const index = nodeIndexOf(cs.nodes)
  for (const [id, by] of deltas) {
    const node = by === 0 ? undefined : index.get(id)
    if (!node) continue
    // Inside a batch (an Undo) the store is written at its end: count on from what it gathered.
    const count = gatheringNodeUpdates()?.get(node.id)?.childCount ?? node.data?.childCount
    cs.updateNode(node.id, { childCount: Math.max(0, (Number(count) || 0) + by) })
  }
}

/** Draw `childKey` under `link`'s parent (none: at the top level) in place of every parent link it
 *  shows now, its parents' child counts moving with it. */
function relink(childKey: string, link: LineageEdge | null, isContainment: (e: LineageEdge) => boolean) {
  const cs = useCanvasStore.getState()
  const deltas = new Map<string, number>()
  for (const e of cs.edges.filter((x) => x.target === childKey && isContainment(x))) {
    cs.removeEdge(e.id)
    addTo(deltas, e.source, -1)
  }
  if (link) {
    cs.addEdges([link])
    addTo(deltas, link.source, 1)
  }
  shiftChildCounts(deltas)
}

/** Put the moved entity's own placement back as it was before the move. */
function restorePin(childKey: string, pin: LayerAssignmentEntry | null) {
  const w = layoutWriter()
  if (!w) return
  const current = w.current()
  const back = restoreAssignment(current, childKey, pin)
  if (back !== current) w.persist(back)
}

/**
 * Where a moved entity is shown — the rule a create follows (ContextViewCanvas `onEntityStaged`).
 * Placed by hand in a column that holds its type (an App in the Apps column), it stays there; any
 * other placement is cleared, so it follows its new parent. At the top level there is no parent to
 * follow: it keeps its placement, else takes the column that holds its type, else the one it was
 * drawn in. Returns the column it is placed in by hand, if any.
 */
function placeMoved(childKey: string, childType: string, toTop: boolean, drawnIn: string | undefined): string | undefined {
  const w = layoutWriter()
  if (!w) return undefined
  const layout = w.current()
  const pin = layout.assignments[childKey]
  const holdsType = (layerId: string) => (layout.layers.find((l) => l.id === layerId)?.entityTypes ?? []).includes(childType)
  if (toTop) {
    if (pin) return pin.layerId
    const column = layout.layers.find((l) => (l.entityTypes ?? []).includes(childType))?.id ?? drawnIn
    if (!column || !layout.layers.some((l) => l.id === column)) return undefined
    w.persist(assignEntities(layout, [childKey], column))
    return column
  }
  if (pin && holdsType(pin.layerId)) return pin.layerId
  if (pin) w.persist(unassignEntities(layout, [childKey]))
  useReferenceModelStore.getState().removeEntityAssignment(childKey)
  return undefined
}

const columnName = (layerId: string | undefined) =>
  layerId ? layoutWriter()?.current().layers.find((l) => l.id === layerId)?.name : undefined

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
  // removes whatever parent link the child has and adds the new one (none: to the top level) — so
  // the move is exact even when the canvas never loaded the old link (it used to delete only a
  // LOADED link, and a node whose old link was not loaded ended up under both parents). On the
  // canvas the move is shown at once: every loaded parent link of the child is removed, the new one
  // drawn as pending, and the child placed by `placeMoved`. The staged overlay keeps all of that
  // across any reload. Returns the column the child stays in by hand, if any.
  const restageContainment = useCallback(
    (childKey: string, parentKey: string | null, parentLabel: string, containmentType: string | null) => {
      const canvas = useCanvasStore.getState()
      const staged = useStagedChangesStore.getState()
      const prior = staged.changes.find(
        (c) => c.type === 'move_entity' && (c.after as MoveAfter).childId === childKey,
      )
      // The state before the FIRST move of this child (a later move replaces the earlier one, so
      // discarding restores the true starting point). A move restored from an older snapshot kept
      // the whole layout; its pin is read off it.
      const priorBefore = prior?.before as (Partial<MoveBefore> & { layout?: NormalizedReferenceLayout | null }) | undefined
      const before: MoveBefore = priorBefore
        ? {
          removedLinks: priorBefore.removedLinks ?? [],
          pin: 'pin' in priorBefore ? priorBefore.pin ?? null : priorBefore.layout?.assignments[childKey] ?? null,
        }
        : {
          removedLinks: canvas.edges.filter((e) => e.target === childKey && isContainment(e) && e.data?.isPending !== 'create'),
          pin: layoutWriter()?.current().assignments[childKey] ?? null,
        }

      const label = (id: string) =>
        (nodeIndexOf(canvas.nodes).get(id)?.data?.label as string | undefined) ?? id
      const childType = (nodeIndexOf(canvas.nodes).get(childKey)?.data?.type as string | undefined) ?? ''
      const drawnIn = moveHost()?.columnOf(childKey)
      const fromLabels = [...new Set(before.removedLinks.map((e) => label(e.source)))]
      const edgeId = parentKey ? generateId('staged-edge') : null
      const newLink: LineageEdge | null = parentKey && containmentType && edgeId
        ? {
          id: edgeId, source: parentKey, target: childKey, type: 'containment',
          data: { edgeType: containmentType, relationship: containmentType.toLowerCase(), isPending: 'create' },
        }
        : null
      const after: MoveAfter = {
        childId: childKey, parentId: parentKey, edgeId, edgeType: containmentType,
        containmentTypes: containmentEdgeTypes.map((t) => t.toUpperCase()),
      }
      let keptIn: string | undefined
      const show = () => {
        relink(childKey, newLink, isContainment)
        keptIn = placeMoved(childKey, childType, parentKey === null, drawnIn)
      }
      show()
      const to = parentKey ? `'${parentLabel}'` : 'the top level'
      useStagedChangesStore.getState().stageOrReplace(
        (c) => c.type === 'move_entity' && (c.after as MoveAfter).childId === childKey,
        {
          type: 'move_entity',
          targetId: childKey,
          targetUrn: (nodeIndexOf(canvas.nodes).get(childKey)?.data?.urn as string) ?? childKey,
          before,
          after,
          summary: fromLabels.length > 0
            ? `Move '${label(childKey)}' from '${fromLabels.join("', '")}' to ${to}`
            : `Move '${label(childKey)}' to ${to}`,
          discard: () => {
            const cs = useCanvasStore.getState()
            const deltas = new Map<string, number>()
            // The links this move drew (a re-move's included) go; the ones it replaced come back.
            for (const e of cs.edges.filter((x) => x.target === childKey && isContainment(x) && x.data?.isPending === 'create')) {
              cs.removeEdge(e.id)
              addTo(deltas, e.source, -1)
            }
            cs.addEdges(before.removedLinks)
            for (const e of before.removedLinks) addTo(deltas, e.source, 1)
            shiftChildCounts(deltas)
            restorePin(childKey, before.pin)
          },
          reapply: show,
        },
      )
      return keptIn
    },
    [isContainment, containmentEdgeTypes],
  )

  // A node created in this draft: its staged create says where it goes — point it at the new parent
  // (none: the top level) and swap its pending link, so the save makes exactly one parent link. One
  // undoable step: Undo draws it under its old parent, with its old placement, again. Returns the
  // column it stays in by hand, if any; false when there is no create to point (nothing changed).
  const restageCreate = useCallback(
    (childKey: string, parentKey: string | null, parentLabel: string | undefined, containmentType: string | null): string | undefined | false => {
      const staged = useStagedChangesStore.getState()
      const prev = staged.changes.find((c) => c.type === 'create_entity' && (c.targetUrn ?? c.targetId) === childKey)
      if (!prev) return false
      const was = prev.after as CreateAfter
      const drawnIn = moveHost()?.columnOf(childKey)
      const pinBefore = layoutWriter()?.current().assignments[childKey] ?? null
      // The id a create gives its pending link (useStageEntityCreation).
      const linkUnder = (parent: string | null | undefined, type: string | null | undefined): LineageEdge | null =>
        parent && type
          ? {
            id: `contains-${parent}-${childKey}`, source: parent, target: childKey, type: 'containment',
            data: { edgeType: type, relationship: type.toLowerCase(), isPending: 'create' },
          }
          : null
      let keptIn: string | undefined
      const forth = () => {
        relink(childKey, linkUnder(parentKey, containmentType), isContainment)
        keptIn = placeMoved(childKey, was.entityType, parentKey === null, drawnIn)
      }
      const back = () => {
        relink(childKey, linkUnder(was.parentUrn, was.containmentEdgeType), isContainment)
        restorePin(childKey, pinBefore)
      }
      const nested = !!parentKey && !!containmentType
      const after: CreateAfter = nested
        ? { ...was, parentUrn: parentKey!, containmentEdgeType: containmentType!, parentLabel }
        : { ...was, parentUrn: undefined, containmentEdgeType: undefined, parentLabel: undefined }
      forth()
      staged.replace({ ...prev, reapply: back }, {
        ...prev,
        after,
        summary: nested
          ? `Create ${was.entityType}: '${was.displayName}' · ${containmentType}${parentLabel ? ` ${parentLabel}` : ''}`
          : `Create ${was.entityType}: '${was.displayName}'`,
        reapply: forth,
      })
      return keptIn
    },
    [isContainment],
  )

  // returnToParent — undo a VIEW placement: the entity shows under its parent again. The data is
  // untouched (it never left its parent there). A placement made in this session is simply
  // cancelled — its own undo restores the layout; a saved one is removed as a layout change that
  // Review & Save lists and discard reverts. Returns false when the entity has no placement.
  const returnToParent = useCallback((entityId: string, parentLabel?: string): boolean => {
    const { nodes } = useCanvasStore.getState()
    const node = nodes.find((n) => n.id === entityId || (n.data?.urn as string) === entityId)
    const key = node?.id ?? entityId
    const name = (node?.data?.label as string) || 'This entity'
    const staged = useStagedChangesStore.getState()
    const done = () => notify('success', `'${name}' is back under ${parentLabel ? `'${parentLabel}'` : 'its parent'}.`)
    const prior = staged.changes.find(
      (c) => (c.type === 'assign_layer' || c.type === 'move_to_layer') && c.targetId === key,
    )
    if (prior) {
      staged.discard(prior.id)
      useReferenceModelStore.getState().removeEntityAssignment(key)
      done()
      return true
    }
    const w = layoutWriter()
    const before = w?.current()
    if (!w || !before?.assignments[key]) return false
    const after = unassignEntities(before, [key])
    w.persist(after)
    useReferenceModelStore.getState().removeEntityAssignment(key)
    staged.stage({
      type: 'assign_layer',
      targetId: key,
      targetUrn: (node?.data?.urn as string) ?? key,
      before: { layerId: before.assignments[key].layerId },
      after: { layerId: null },
      summary: `Return '${name}' to its parent${parentLabel ? ` '${parentLabel}'` : ''}`,
      discard: () => layoutWriter()?.persist(before),
      reapply: () => layoutWriter()?.persist(after),
    })
    done()
    return true
  }, [notify])

  const typeName = useCallback((id: string) => {
    const name = entityTypes.find((t) => t.id.toLowerCase() === id.toLowerCase())?.name ?? id
    return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`
  }, [entityTypes])

  /** What dropping `draggedId` onto `newParentId` would do — nothing is staged. */
  const verdict = useCallback((draggedId: string, newParentId: string): MoveVerdict => {
    if (!draggedId || !newParentId || draggedId === newParentId) return NONE
    const { nodes, edges } = useCanvasStore.getState()
    const index = nodeIndexOf(nodes)
    const dragged = index.get(draggedId)
    const newParent = index.get(newParentId)
    if (!dragged || !newParent || dragged.id === newParent.id) return NONE
    const tree = containmentIndexOf(edges, containmentEdgeTypes)

    // Cycle: walking up from the new parent meets the dragged node — it would go inside itself.
    const seen = new Set<string>()
    for (let at: string | undefined = newParent.id; at && !seen.has(at); at = tree.parentEdgeOf.get(at)?.source) {
      if (at === dragged.id) {
        return refused({ hint: 'It is inside the one you are moving', message: "Can't move an entity inside one of its own descendants." }, 'error')
      }
      seen.add(at)
    }
    // Already its parent in the data: a drop here means "show it under its parent again" — undo a
    // view placement that holds it elsewhere (nothing, when there is none).
    if (tree.parentEdgeOf.get(dragged.id)?.source === newParent.id) {
      return layoutWriter()?.current().assignments[dragged.id] ? { kind: 'view' } : NONE
    }

    const gate = moveHost()?.blocked()
    if (gate) return refused(gate)

    const childType = dragged.data?.type as string
    const parentType = newParent.data?.type as string
    // A type that holds nothing takes nothing — as a row offers no "+" for a child (isClosedToNesting).
    if (isClosedToNesting(parentType, entityTypes, hierarchyMap)) {
      const p = typeName(parentType)
      return refused({ hint: `${p[0].toUpperCase()}${p.slice(1)} holds nothing`, message: `A ${parentType} can't contain other entities.` }, 'error')
    }
    if (!setHasId(allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap), childType)) {
      const p = typeName(parentType)
      return refused({ hint: `${p[0].toUpperCase()}${p.slice(1)} can't hold ${typeName(childType)}`, message: `A ${parentType} can't contain a ${childType}.` }, 'error')
    }
    // Forward-orientation containment relationship (the new edge is stored parent→child). No
    // fallback to containmentEdgeTypes[0]: if no relationship type's endpoint constraints admit
    // this exact parent→child pair, the move is ontology-invalid — abort rather than stage an
    // edge the backend would reject.
    const fwd = relationshipTypes.find((rt) =>
      isContainmentRelType(rt, containmentEdgeTypes) &&
      endpointOk(parentType, rt.sourceTypes) && endpointOk(childType, rt.targetTypes),
    )
    if (!fwd) {
      return refused({ hint: 'No relationship fits', message: 'No containment relationship is allowed between these entities.' }, 'error')
    }
    // A move is a draft-save op (the server resolves the node's current parent), so it needs a
    // draft — whether or not the canvas has loaded the node's current parent link.
    if (!useBranchStore.getState().currentBranchId) return refused(NOT_IN_DRAFT)
    return { kind: 'data', edgeType: fwd.id }
  }, [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, typeName])

  /** What "On its own, at the top" would do for `childId` — nothing is staged. */
  const topLevelVerdict = useCallback((childId: string): MoveVerdict => {
    const { nodes, edges } = useCanvasStore.getState()
    const node = nodeIndexOf(nodes).get(childId)
    // At the top already, as far as this canvas has loaded.
    if (!node || !containmentIndexOf(edges, containmentEdgeTypes).parentEdgeOf.has(node.id)) return NONE
    const gate = moveHost()?.blocked()
    if (gate) return refused(gate)
    const type = node.data?.type as string
    if (!setHasId(allowedChildTypeIds(null, entityTypes, rootEntityTypes, hierarchyMap), type)) {
      const t = typeName(type)
      return refused({ hint: `${t[0].toUpperCase()}${t.slice(1)} needs a parent`, message: `A ${type} can't stand on its own — it needs a parent.` }, 'error')
    }
    if (!useBranchStore.getState().currentBranchId) return refused(NOT_IN_DRAFT)
    return { kind: 'data', edgeType: null }
  }, [entityTypes, rootEntityTypes, hierarchyMap, containmentEdgeTypes, typeName])

  /** Stage `verdict` for `childKey` under `parentKey` (none: the top level); false when refused. */
  const stageMove = useCallback((childKey: string, parentKey: string | null, v: MoveVerdict): boolean => {
    if (v.kind === 'none') return false
    if (v.kind === 'blocked') {
      notify(v.tone, v.message)
      return false
    }
    if (v.kind !== 'data') return false
    const { nodes } = useCanvasStore.getState()
    const index = nodeIndexOf(nodes)
    const child = index.get(childKey)
    const parentLabel = parentKey ? ((index.get(parentKey)?.data?.label as string) || parentKey) : undefined
    const keptIn = child?.data?.isPending === 'create'
      ? restageCreate(childKey, parentKey, parentLabel, v.edgeType)
      : restageContainment(childKey, parentKey, parentLabel ?? '', v.edgeType)
    if (keptIn === false) {
      notify('info', `'${(child?.data?.label as string) || 'This entity'}' is new — save it first, then you can move it.`,
        { label: 'Review & Save', onClick: () => useStagedChangesStore.getState().openReviewPanel() })
      return false
    }
    moveHost()?.moved(childKey, parentKey)
    const column = columnName(keptIn)
    notify('success', parentKey
      ? `Moved under ${parentLabel}.${column ? ` It stays in ${column}, the column that holds its type.` : ''}`
      : `Moved to the top level${column ? `, shown in ${column}` : ''}.`)
    return true
  }, [notify, restageCreate, restageContainment])

  const reparent = useCallback((draggedId: string, newParentId: string) => {
    const v = verdict(draggedId, newParentId)
    const index = nodeIndexOf(useCanvasStore.getState().nodes)
    const child = index.get(draggedId)
    const parent = index.get(newParentId)
    if (!child || !parent) return
    if (v.kind === 'view') {
      returnToParent(child.id, (parent.data?.label as string) || undefined)
      return
    }
    stageMove(child.id, parent.id, v)
  }, [verdict, returnToParent, stageMove])

  /** "On its own, at the top": no parent at all, where the ontology lets its type stand alone. */
  const moveToTopLevel = useCallback((childId: string) => {
    const child = nodeIndexOf(useCanvasStore.getState().nodes).get(childId)
    if (child) stageMove(child.id, null, topLevelVerdict(child.id))
  }, [topLevelVerdict, stageMove])

  // retypeContainment — keep the SAME parent, switch the containment relationship
  // TYPE. The backend edge_type is immutable, so this is a delete-old + create-new
  // (NOT an update). No-op when the type is unchanged.
  const retypeContainment = useCallback((childId: string, newEdgeType: string) => {
    if (!childId || !newEdgeType) return
    const { nodes, edges } = useCanvasStore.getState()
    const child = nodes.find((n) => n.id === childId || (n.data?.urn as string) === childId)
    if (!child) return
    const childKey = child.id

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

    const parentLabel = (parent?.data?.label as string) || parentKey
    // New in this draft: its staged create carries the relationship.
    if (child.data?.isPending === 'create') {
      if (restageCreate(childKey, parentKey, parentLabel, newEdgeType) !== false) notify('success', 'Relationship updated.')
      return
    }
    restageContainment(childKey, parentKey, parentLabel, newEdgeType)
    notify('success', 'Relationship updated.')
  }, [relationshipTypes, containmentEdgeTypes, notify, isContainment, restageContainment, restageCreate])

  return { reparent, moveToTopLevel, verdict, topLevelVerdict, retypeContainment, returnToParent }
}
