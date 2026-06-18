/**
 * useStageEntityCreation — the single path for creating an entity.
 *
 * Adds an optimistic node (and, when nested, a containment edge) to the canvas
 * immediately with `isPending:'create'`, and stages a `create_entity` change.
 * The actual backend write happens on Save via the staged change's `apply` hook
 * (branch-scoped `provider.createNode`), which also remaps the optimistic temp
 * urn to the real one.
 *
 * Hierarchy fix: when creating a child under a parent that is ITSELF still
 * staged (grandparent→parent→child built before any Save), the parent's temp
 * urn doesn't exist on the backend yet. Phase-1 of the draft save creates
 * parents before children (staged in order) and registers their temp→real
 * urns, so the child's apply hook resolves its parent urn through
 * `resolveTempId` before calling `createNode`.
 */
import { useCallback } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { generateId } from '@/lib/utils'

export interface StageEntityInput {
  entityType: string
  displayName: string
  /** Parent node urn for nested creation (may be another staged node's temp urn). */
  parentUrn?: string | null
  tags?: string[]
  /** Free-form properties (description, custom schema fields, etc.). */
  properties?: Record<string, unknown>
  /**
   * The ontology containment relationship to use for the parent→child edge
   * (e.g. CONTAINS / partOf / belongsTo). When omitted, falls back to the first
   * resolved containment type. Ignored when there is no parent.
   */
  containmentEdgeType?: string
}

export function useStageEntityCreation() {
  const addNodes = useCanvasStore((s) => s.addNodes)
  const addEdges = useCanvasStore((s) => s.addEdges)
  const removeNode = useCanvasStore((s) => s.removeNode)
  const removeEdge = useCanvasStore((s) => s.removeEdge)
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const stageChange = useStagedChangesStore((s) => s.stage)

  /** Stage a new entity. Returns its optimistic temp urn. */
  const stageEntity = useCallback(
    (input: StageEntityInput): string => {
      const tags = input.tags ?? []
      const properties = input.properties ?? {}
      // Only treat the parent as a CONTAINMENT parent when it's a real node on
      // the canvas (a just-staged node counts — it's in the store). A layer id
      // or a not-yet-loaded container would otherwise produce a dangling
      // containment edge (a parent with no node), which orphans the new node in
      // the hierarchy. When the parent isn't a node, create at the root and let
      // layer assignment place it.
      const parentUrnRaw = input.parentUrn || undefined
      const parentNode = parentUrnRaw
        ? useCanvasStore.getState().nodes.find(
            (n) => n.id === parentUrnRaw || (n.data?.urn as string) === parentUrnRaw,
          )
        : undefined
      const parentUrn = parentNode ? parentUrnRaw : undefined
      const parentLabel = (parentNode?.data?.label as string) || undefined

      const tempUrn = `urn:staged:${input.entityType}:${generateId('new')}`
      const containmentEdgeId = parentUrn ? `contains-${parentUrn}-${tempUrn}` : null
      // Prefer the caller's ontology-chosen relationship; fall back to the first
      // resolved containment type (then the literal CONTAINS) for callers that
      // don't pick one.
      const containmentEdgeType = input.containmentEdgeType || containmentEdgeTypes[0] || 'CONTAINS'

      addNodes([{
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
        addEdges([{
          id: containmentEdgeId,
          source: parentUrn,
          target: tempUrn,
          type: 'containment',
          // `isPending:'create'` marks this as optimistic/unsaved so the collapse
          // cleanup never drops it (no server re-fetch path) — keeps the hierarchy
          // intact through collapse/expand before Save.
          data: { edgeType: containmentEdgeType, relationship: containmentEdgeType.toLowerCase(), isPending: 'create' },
        }])
      }

      stageChange({
        type: 'create_entity',
        targetId: tempUrn,
        targetUrn: tempUrn,
        after: {
          entityType: input.entityType, displayName: input.displayName, parentUrn, tags, properties,
          // Recorded so the staged-changes review can show how the child is related to its parent.
          ...(parentUrn ? { containmentEdgeType, parentLabel } : {}),
        },
        summary: parentUrn
          ? `Create ${input.entityType}: '${input.displayName}' · ${containmentEdgeType}${parentLabel ? ` ${parentLabel}` : ''}`
          : `Create ${input.entityType}: '${input.displayName}'`,
        apply: async ({ provider, registerTempIdResolution, resolveTempId }) => {
          if (!provider) {
            // No provider — accept the local-only creation by clearing the pending flag.
            useCanvasStore.getState().updateNode(tempUrn, { isPending: undefined })
            return
          }
          // Resolve a staged parent's temp urn to its real urn (set when the
          // parent's own create_entity applied earlier in this save).
          const resolvedParent = parentUrn ? (resolveTempId(parentUrn) ?? parentUrn) : undefined
          const result = await provider.createNode({
            entityType: input.entityType as never,
            displayName: input.displayName,
            parentUrn: resolvedParent,
            containmentEdgeType: parentUrn ? containmentEdgeType : undefined,
            properties,
            tags,
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
          if (containmentEdgeId) removeEdge(containmentEdgeId)
          removeNode(tempUrn)
        },
      })

      return tempUrn
    },
    [addNodes, addEdges, removeNode, removeEdge, containmentEdgeTypes, stageChange],
  )

  return { stageEntity }
}
