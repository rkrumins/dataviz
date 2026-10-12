/**
 * useBulkLinkModel — one reading of a bulk link, for every surface that shows
 * it (the drop card, the Link panel): the pairs in the stated direction, the
 * relationships that fit, each pair's verdict, and the limits. Two surfaces
 * computing it separately could disagree about what "Add 9 links" adds.
 *
 * Judged by the VIEW's ontology (the view hooks), the same one the canvas
 * hands `stageEdgeCreateMany`, so the preview and the staging agree.
 */
import { useMemo } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useViewContainmentEdgeTypes, useViewEntityTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import {
  BULK_LINK_CONFIRM_ABOVE,
  BULK_LINK_MAX,
  batchTypeOptions,
  expandPairs,
  judgePairs,
  makeFitChecker,
  type BulkLinkContext,
} from '@/lib/bulkLinks'
import { relationshipLabel } from '@/lib/relationshipLabel'
import { useBulkLinkStore } from './bulkLinkStore'

export interface EntityLook {
  typeName: string
  icon: string
  color: string
}

export function useBulkLinkModel(selection: readonly string[]) {
  const direction = useBulkLinkStore((s) => s.direction)
  const picked = useBulkLinkStore((s) => s.picked)
  const chosenType = useBulkLinkStore((s) => s.chosenType)

  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const entityTypes = useViewEntityTypes()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()

  const typeOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) {
      const type = n.data?.type as string | undefined
      if (!type) continue
      m.set(n.id, type)
      const urn = n.data?.urn as string | undefined
      if (urn) m.set(urn, type)
    }
    return m
  }, [nodes])

  const ctx: BulkLinkContext = useMemo(() => ({
    typeOf: (urn) => typeOf.get(urn) ?? null,
    relationshipTypes,
    containmentEdgeTypes,
    entityTypes,
    existingEdges: edges,
  }), [typeOf, relationshipTypes, containmentEdgeTypes, entityTypes, edges])

  const fit = useMemo(() => makeFitChecker(ctx), [ctx])

  const typeById = useMemo(() => new Map(entityTypes.map((t) => [t.id, t])), [entityTypes])
  /** An entity's type, as the ontology draws it. */
  const lookOf = useMemo(() => (id: string): EntityLook => {
    const typeId = typeOf.get(id) ?? ''
    const t = typeById.get(typeId)
    return { typeName: t?.name ?? typeId, icon: t?.visual?.icon ?? 'Box', color: t?.visual?.color ?? '#6366f1' }
  }, [typeOf, typeById])

  const pairs = useMemo(() => expandPairs(selection, picked, direction), [selection, picked, direction])
  const options = useMemo(() => batchTypeOptions(pairs, ctx), [pairs, ctx])
  const option = options.find((o) => o.edgeType === chosenType) ?? options[0] ?? null
  const edgeType = option?.edgeType ?? null
  const relationship = option ? (option.label && option.label !== option.edgeType ? option.label : relationshipLabel(option.edgeType)) : null
  const verdicts = useMemo(() => (edgeType ? judgePairs(pairs, edgeType, ctx) : []), [pairs, edgeType, ctx])
  const toCreate = useMemo(() => verdicts.filter((v) => v.ok), [verdicts])

  // Why nothing fits, in the ontology's words.
  const noFitReason = pairs.length > 0 && options.length === 0
    ? (fit(pairs[0].source, pairs[0].target).reason ?? 'These are already linked by every relationship that could join them.')
    : null

  const sources = direction === 'selection-feeds' ? selection : picked
  const targets = direction === 'selection-feeds' ? picked : selection

  return {
    direction,
    picked,
    sources,
    targets,
    pairs,
    options,
    edgeType,
    relationship,
    verdicts,
    toCreate,
    skipped: verdicts.length - toCreate.length,
    overMax: toCreate.length > BULK_LINK_MAX,
    needsConfirm: toCreate.length > BULK_LINK_CONFIRM_ABOVE,
    noFitReason,
    fit,
    lookOf,
    typeOf,
    ctx,
  }
}

export type BulkLinkModel = ReturnType<typeof useBulkLinkModel>
