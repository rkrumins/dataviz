/**
 * useHierarchyOutline — the outliner model behind the Hierarchy Builder panel.
 *
 * Committed rows in the outline ARE the staged `create_entity` changes — there
 * is no separate row store. The flattened `tree` is re-derived from
 * `useStagedChanges()` on every change, reimplementing UnifiedCreatePanel's
 * `StagedOutline` roots/children grouping (that component is deleted in a
 * later task, so this hook owns the derivation now rather than importing it).
 *
 * Exactly ONE uncommitted "active row" lives in local hook state — the row
 * the user is currently typing into. Enter/Tab/Shift+Tab drive it through the
 * ontology gates (`allowedChildTypeIds` / `deriveContainmentEdges`) before
 * staging via `useStageEntityCreation`.
 *
 * This hook never calls `ensureDraftOpen` — the builder store's `open()`
 * already guarantees a draft is active before the panel (and this hook) ever
 * mounts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChanges, useStagedChangesStore } from '@/store/stagedChangesStore'
import {
  useViewEntityTypes,
  useViewRootEntityTypes,
  useViewEntityTypeHierarchyMap,
  useViewRelationshipTypes,
  useViewContainmentEdgeTypes,
} from '@/hooks/useViewSchema'
import {
  builderAllowedChildTypeIds,
  deriveContainmentEdges,
  isClosedToNesting,
  type AllowedEdgeOption,
} from '@/services/ontologyPreflightService'
import { useStageEntityCreation } from './useStageEntityCreation'
import { useHierarchyBuilderStore } from './hierarchyBuilderStore'
import type { ParsedOutlineRow } from './outlineParser'
import type { EntityTypeSchema } from '@/types/schema'

export interface OutlineRow {
  changeId: string
  tempUrn: string
  name: string
  typeId: string
  /** Absent/undefined = root-level staged create. */
  parentUrn?: string
  /** Depth within the staged tree. */
  depth: number
  /** description/tags/custom fields present. */
  hasDetails: boolean
}

export interface ActiveRow {
  name: string
  typeId: string | null
  parentUrn: string | null
  edgeType: string | null
  /** tags = raw comma-string; the panel parses on commit. */
  details: { description: string; tags: string; fieldValues: Record<string, unknown> }
}

/** Lowest hierarchy.level first, then name — matches outlineParser's tie-break. */
function sortByLevelThenName(types: EntityTypeSchema[]): EntityTypeSchema[] {
  return [...types].sort((a, b) => {
    const diff = a.hierarchy.level - b.hierarchy.level
    return diff !== 0 ? diff : a.name.localeCompare(b.name)
  })
}

export function useHierarchyOutline(opts: {
  scopeParentUrn: string | null
  initialTypeId: string | null
  onEntityStaged?: (tempUrn: string, parentUrn?: string) => void
}) {
  const { scopeParentUrn, initialTypeId, onEntityStaged } = opts

  const entityTypes = useViewEntityTypes()
  const rootEntityTypes = useViewRootEntityTypes()
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()

  const canvasNodes = useCanvasStore((s) => s.nodes)
  const allStaged = useStagedChanges()
  const { stageEntity, updateStagedEntity } = useStageEntityCreation()

  // --- Session batch boundary: `batchId` bumps on every open()/openBuild()
  // even when this hook stays mounted across it (the panel has a stable
  // key) — `batchUrns` is which staged temp urns belong to the CURRENT
  // batch, cleared on each open(). Nothing un-stages: earlier batches stay
  // in `allStaged` (and on the canvas), they just drop out of `tree` below.
  const batchId = useHierarchyBuilderStore((s) => s.batchId)
  const batchUrns = useHierarchyBuilderStore((s) => s.batchUrns)
  const registerBatchUrn = useHierarchyBuilderStore((s) => s.registerBatchUrn)

  const [active, setActive] = useState<ActiveRow>(() => ({
    name: '',
    typeId: null,
    parentUrn: scopeParentUrn,
    edgeType: null,
    details: { description: '', tags: '', fieldValues: {} },
  }))
  const [indentBlockedReason, setIndentBlockedReason] = useState<string | null>(null)

  const firstOpenConsumed = useRef(false)
  const lastUsedTypeAtDepth = useRef(new Map<number, string>())
  const lastCommittedTempUrn = useRef<string | null>(null)

  // --- Tree derivation (rule 1): committed rows ARE the staged create_entity
  // changes. Reimplements StagedOutline's roots/children grouping, flattened
  // depth-first with an explicit `depth` instead of nested JSX.
  const tree = useMemo<OutlineRow[]>(() => {
    interface Node {
      changeId: string
      tempUrn: string
      name: string
      typeId: string
      parentUrn?: string
      hasDetails: boolean
    }
    const batchSet = new Set(batchUrns)
    const nodes: Node[] = allStaged
      .filter((c) => c.type === 'create_entity' && batchSet.has(c.targetUrn ?? c.targetId))
      .map((c) => {
        const a = (c.after ?? {}) as {
          displayName?: string
          entityType?: string
          parentUrn?: string
          properties?: Record<string, unknown>
          tags?: string[]
        }
        const detailKeys = Object.keys(a.properties ?? {}).filter((k) => k !== 'layerAssignment')
        return {
          changeId: c.id,
          tempUrn: c.targetUrn ?? c.targetId,
          name: a.displayName || 'Untitled',
          typeId: a.entityType || '',
          parentUrn: a.parentUrn,
          hasDetails: detailKeys.length > 0 || (a.tags?.length ?? 0) > 0,
        }
      })
    const byTemp = new Map(nodes.map((n) => [n.tempUrn, n]))
    const childrenOf = new Map<string, Node[]>()
    const roots: Node[] = []
    for (const n of nodes) {
      if (n.parentUrn && byTemp.has(n.parentUrn)) {
        const arr = childrenOf.get(n.parentUrn) ?? []
        arr.push(n)
        childrenOf.set(n.parentUrn, arr)
      } else {
        roots.push(n)
      }
    }
    const out: OutlineRow[] = []
    const walk = (n: Node, depth: number) => {
      out.push({ ...n, depth })
      for (const child of childrenOf.get(n.tempUrn) ?? []) walk(child, depth + 1)
    }
    for (const r of roots) walk(r, 0)
    return out
  }, [allStaged, batchUrns])

  /** Entity type id of `parentUrn` — a staged row (looked up in `tree`) or a real canvas node. */
  const parentTypeOf = useCallback(
    (parentUrn: string | null): string | null => {
      if (!parentUrn) return null
      const row = tree.find((r) => r.tempUrn === parentUrn)
      if (row) return row.typeId
      const node = canvasNodes.find((n) => n.id === parentUrn || (n.data?.urn as string) === parentUrn)
      return (node?.data?.type as string) || null
    },
    [tree, canvasNodes],
  )

  /** Depth WITHIN THE STAGED TREE for a row parented at `parentUrn` (0 = a root of the staged tree). */
  const depthForParent = useCallback(
    (parentUrn: string | null): number => {
      if (!parentUrn) return 0
      const row = tree.find((r) => r.tempUrn === parentUrn)
      return row ? row.depth + 1 : 0
    },
    [tree],
  )

  /** THE gate for `allowedTypes`, `indent`, and `blockedReason` (rule 2). */
  const allowedTypesFor = useCallback(
    (parentUrn: string | null): EntityTypeSchema[] => {
      const ids = builderAllowedChildTypeIds(
        parentTypeOf(parentUrn), entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes,
      )
      const types = [...ids]
        .map((id) => entityTypes.find((et) => et.id === id))
        .filter((t): t is EntityTypeSchema => !!t)
      return sortByLevelThenName(types)
    },
    [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, parentTypeOf],
  )

  const allowedTypes = useMemo(() => allowedTypesFor(active.parentUrn), [allowedTypesFor, active.parentUrn])

  // --- Type inference (rule 3): recompute only when the PARENT changes — a
  // user's manual `setType` pick persists across renders until then.
  useEffect(() => {
    const allowed = allowedTypesFor(active.parentUrn)
    const depth = depthForParent(active.parentUrn)
    let nextType: string | null
    if (!firstOpenConsumed.current && initialTypeId && allowed.some((t) => t.id === initialTypeId)) {
      nextType = initialTypeId
    } else if (allowed.length === 1) {
      nextType = allowed[0].id
    } else {
      const lastUsed = lastUsedTypeAtDepth.current.get(depth)
      nextType = lastUsed && allowed.some((t) => t.id === lastUsed) ? lastUsed : (allowed[0]?.id ?? null)
    }
    firstOpenConsumed.current = true
    setActive((prev) => (prev.typeId === nextType ? prev : { ...prev, typeId: nextType }))
    // Intentionally keyed on parentUrn only (rule 3): a manual setType() pick
    // must persist across unrelated re-renders until the parent itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.parentUrn])

  // --- Edge options + auto-pick (rule 4). No parent = nothing to nest into,
  // so no containment edge is relevant (mirrors UnifiedCreatePanel).
  const edgeOptions = useMemo<AllowedEdgeOption[]>(() => {
    if (!active.parentUrn || !active.typeId) return []
    const parentType = parentTypeOf(active.parentUrn)
    if (!parentType) return []
    return deriveContainmentEdges(parentType, active.typeId, relationshipTypes, containmentEdgeTypes).filter(
      (o) => o.allowed,
    )
  }, [active.parentUrn, active.typeId, parentTypeOf, relationshipTypes, containmentEdgeTypes])

  useEffect(() => {
    setActive((prev) => {
      if (prev.edgeType && edgeOptions.some((o) => o.edgeType === prev.edgeType)) return prev
      if (edgeOptions.length === 0) return prev.edgeType === null ? prev : { ...prev, edgeType: null }
      const contains = edgeOptions.find((o) => o.edgeType.toUpperCase() === 'CONTAINS')
      const next = (contains ?? edgeOptions[0]).edgeType
      return prev.edgeType === next ? prev : { ...prev, edgeType: next }
    })
  }, [edgeOptions])

  const edgeBlockedReason = useMemo(() => {
    if (!active.parentUrn || !active.typeId) return null
    if (edgeOptions.length > 0) return null
    const parentType = parentTypeOf(active.parentUrn)
    const parentLabel = entityTypes.find((et) => et.id === parentType)?.name ?? parentType ?? 'this'
    const typeLabel = entityTypes.find((et) => et.id === active.typeId)?.name ?? active.typeId
    return `A ${parentLabel} can't contain a ${typeLabel}.`
  }, [active.parentUrn, active.typeId, edgeOptions, parentTypeOf, entityTypes])

  const blockedReason = indentBlockedReason ?? edgeBlockedReason
  const canCommit = Boolean(active.name.trim() && active.typeId && !blockedReason)

  // --- Vanished parent fallback (rule 7): mirrors UnifiedCreatePanel ~:244.
  useEffect(() => {
    if (!active.parentUrn) return
    const isStaged = tree.some((r) => r.tempUrn === active.parentUrn)
    const onCanvas = canvasNodes.some((n) => n.id === active.parentUrn || (n.data?.urn as string) === active.parentUrn)
    if (!isStaged && !onCanvas) {
      setActive((prev) => ({ ...prev, parentUrn: scopeParentUrn }))
    }
  }, [active.parentUrn, tree, canvasNodes, scopeParentUrn])

  // --- Batch boundary scope reset (rule 8): a fresh open()/openBuild() bumps
  // `batchId` even when this hook stays mounted across it (stable panel key)
  // — re-scope `active` to the CURRENT scopeParentUrn so a parent nested into
  // during the PREVIOUS batch doesn't leak into the new one. Mirrors
  // `retarget()`. On mount this is a no-op — the initial useState already
  // seeds parentUrn from scopeParentUrn.
  useEffect(() => {
    setIndentBlockedReason(null)
    setActive((prev) => (prev.parentUrn === scopeParentUrn ? prev : { ...prev, parentUrn: scopeParentUrn }))
    lastCommittedTempUrn.current = null
    // Intentionally keyed on batchId only: scopeParentUrn is read fresh from
    // the store at the moment batchId bumps (same open() call sets both).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId])

  // Typing clears a stale indent-blocked message: indent() only fires on an
  // EMPTY name, so once the user types, the failed Tab is history — leaving the
  // reason set would wrongly gate a perfectly valid sibling commit via canCommit.
  const setName = useCallback((name: string) => {
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, name }))
  }, [])
  const setType = useCallback((typeId: string | null) => {
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, typeId }))
  }, [])
  const setEdgeType = useCallback((edgeType: string | null) => setActive((prev) => ({ ...prev, edgeType })), [])
  const setDetails = useCallback((details: ActiveRow['details']) => setActive((prev) => ({ ...prev, details })), [])

  const retarget = useCallback((parentUrn: string | null) => {
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, parentUrn }))
  }, [])

  const commitSibling = useCallback((): string | null => {
    if (!canCommit || !active.typeId) return null
    const tags = active.details.tags.split(',').map((t) => t.trim()).filter(Boolean)
    const properties: Record<string, unknown> = {
      ...active.details.fieldValues,
      ...(active.details.description.trim() ? { description: active.details.description.trim() } : {}),
    }
    const tempUrn = stageEntity({
      entityType: active.typeId,
      displayName: active.name.trim(),
      parentUrn: active.parentUrn,
      containmentEdgeType: active.edgeType ?? undefined,
      tags,
      properties,
    })
    registerBatchUrn(tempUrn)
    lastUsedTypeAtDepth.current.set(depthForParent(active.parentUrn), active.typeId)
    lastCommittedTempUrn.current = tempUrn
    onEntityStaged?.(tempUrn, active.parentUrn ?? undefined)
    setActive((prev) => ({ ...prev, name: '', details: { description: '', tags: '', fieldValues: {} } }))
    return tempUrn
  }, [canCommit, active, stageEntity, depthForParent, onEntityStaged, registerBatchUrn])

  const commitAndNest = useCallback((): string | null => {
    const tempUrn = commitSibling()
    if (!tempUrn) return null
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, parentUrn: tempUrn }))
    return tempUrn
  }, [commitSibling])

  const indent = useCallback((): boolean => {
    const targetTempUrn = lastCommittedTempUrn.current
    if (!targetTempUrn) return false
    const row = tree.find((r) => r.tempUrn === targetTempUrn)
    if (!row) return false
    if (isClosedToNesting(row.typeId, entityTypes, hierarchyMap)) {
      const label = entityTypes.find((et) => et.id === row.typeId)?.name ?? row.typeId
      setIndentBlockedReason(`Nothing can be added inside a ${label}.`)
      return false
    }
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, parentUrn: targetTempUrn }))
    return true
  }, [tree, entityTypes, hierarchyMap])

  const outdent = useCallback((): boolean => {
    if (active.parentUrn === scopeParentUrn) return false
    const parentRow = active.parentUrn ? tree.find((r) => r.tempUrn === active.parentUrn) : undefined
    const grandParentUrn = parentRow ? (parentRow.parentUrn ?? scopeParentUrn ?? null) : (scopeParentUrn ?? null)
    setIndentBlockedReason(null)
    setActive((prev) => ({ ...prev, parentUrn: grandParentUrn }))
    return true
  }, [active.parentUrn, tree, scopeParentUrn])

  const renameRow = useCallback(
    (tempUrn: string, name: string) => updateStagedEntity(tempUrn, { displayName: name }),
    [updateStagedEntity],
  )

  const updateRowDetails = useCallback(
    (tempUrn: string, details: { description?: string; tags?: string[]; properties?: Record<string, unknown> }) => {
      const patch: { tags?: string[]; properties?: Record<string, unknown> } = {}
      if (details.tags !== undefined) patch.tags = details.tags
      if (details.description !== undefined || details.properties !== undefined) {
        patch.properties = {
          ...(details.properties ?? {}),
          ...(details.description !== undefined ? { description: details.description } : {}),
        }
      }
      updateStagedEntity(tempUrn, patch)
    },
    [updateStagedEntity],
  )

  const removeRow = useCallback((changeId: string) => {
    useStagedChangesStore.getState().discard(changeId)
  }, [])

  const descendantCount = useCallback(
    (tempUrn: string): number => {
      let count = 0
      const walk = (urn: string) => {
        for (const row of tree) {
          if (row.parentUrn === urn) {
            count++
            walk(row.tempUrn)
          }
        }
      }
      walk(tempUrn)
      return count
    },
    [tree],
  )

  const stageRows = useCallback(
    (rows: ParsedOutlineRow[], baseParentUrn: string | null): number => {
      let count = 0
      // Per-depth parent-urn stack starting at baseParentUrn, plus a local
      // type map for rows staged WITHIN this call — `tree`/`parentTypeOf` are
      // snapshots from the last render and don't see these staged-mid-loop rows.
      const parentAt: Record<number, string | null> = { 0: baseParentUrn }
      const skipAt: Record<number, boolean> = {}
      const typeByTempUrn = new Map<string, string>()

      const resolveParentType = (parentUrn: string | null): string | null =>
        parentUrn ? (typeByTempUrn.get(parentUrn) ?? parentTypeOf(parentUrn)) : null

      for (const row of rows) {
        const parentUrn = row.depth === 0 ? baseParentUrn : (parentAt[row.depth] ?? null)
        const ancestorSkipped = row.depth > 0 && !!skipAt[row.depth]

        if (row.issues.length > 0 || !row.typeId || ancestorSkipped) {
          skipAt[row.depth + 1] = true
          continue
        }
        skipAt[row.depth + 1] = false

        const parentType = resolveParentType(parentUrn)
        const edgeOpts = parentUrn && parentType
          ? deriveContainmentEdges(parentType, row.typeId, relationshipTypes, containmentEdgeTypes).filter((o) => o.allowed)
          : []
        const contains = edgeOpts.find((o) => o.edgeType.toUpperCase() === 'CONTAINS')
        const edgeType = edgeOpts.length > 0 ? (contains ?? edgeOpts[0]).edgeType : undefined

        const tempUrn = stageEntity({
          entityType: row.typeId,
          displayName: row.name,
          parentUrn: parentUrn ?? undefined,
          containmentEdgeType: edgeType,
        })

        typeByTempUrn.set(tempUrn, row.typeId)
        parentAt[row.depth + 1] = tempUrn
        count++
        registerBatchUrn(tempUrn)
        onEntityStaged?.(tempUrn, parentUrn ?? undefined)
      }

      return count
    },
    [stageEntity, parentTypeOf, relationshipTypes, containmentEdgeTypes, onEntityStaged, registerBatchUrn],
  )

  return {
    tree,
    active,
    allowedTypes,
    edgeOptions,
    blockedReason,
    canCommit,
    setName,
    setType,
    setEdgeType,
    setDetails,
    retarget,
    commitSibling,
    commitAndNest,
    indent,
    outdent,
    renameRow,
    updateRowDetails,
    removeRow,
    descendantCount,
    stageRows,
  }
}
