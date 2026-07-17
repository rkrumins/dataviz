/**
 * View-scoped schema selector hooks.
 *
 * These hooks read from ViewExecutionContext when inside a view's render tree,
 * and fall back to the global Zustand schema store when outside. This means:
 *
 *   - Canvas components (inside ViewExecutionProvider) get the view's data
 *     source ontology — guaranteed to match the scoped provider.
 *   - Global components (sidebar, dashboard, admin) get the active workspace's
 *     ontology from the Zustand store — unchanged behavior.
 *
 * The hook API is identical to the Zustand selectors they replace, so swapping
 * is a 1-line import change per consumer.
 */

import { useMemo } from 'react'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import {
  useSchemaStore,
  useEntityTypes as useGlobalEntityTypes,
  useRelationshipTypes as useGlobalRelationshipTypes,
  useContainmentEdgeTypes as useGlobalContainmentEdgeTypes,
  useLineageEdgeTypes as useGlobalLineageEdgeTypes,
  useRootEntityTypes as useGlobalRootEntityTypes,
  useSchemaIsLoading as useGlobalSchemaIsLoading,
  isContainmentEdgeType,
  isLineageEdgeType,
} from '@/store/schema'
import type { EntityTypeSchema, EntityVisualConfig, RelationshipTypeSchema } from '@/types/schema'

const EMPTY_STRING_ARRAY: string[] = []

/** Entity types for the current view's data source ontology. */
export function useViewEntityTypes(): EntityTypeSchema[] {
  const ctx = useViewExecutionContext()
  const global = useGlobalEntityTypes()
  return ctx?.schema.entityTypes ?? global
}

/** Relationship types for the current view's ontology. */
export function useViewRelationshipTypes(): RelationshipTypeSchema[] {
  const ctx = useViewExecutionContext()
  const global = useGlobalRelationshipTypes()
  return ctx?.schema.relationshipTypes ?? global
}

/** Containment edge types for the current view's ontology. */
export function useViewContainmentEdgeTypes(): string[] {
  const ctx = useViewExecutionContext()
  const global = useGlobalContainmentEdgeTypes()
  return ctx?.schema.containmentEdgeTypes ?? global
}

/** Lineage edge types for the current view's ontology. */
export function useViewLineageEdgeTypes(): string[] {
  const ctx = useViewExecutionContext()
  const global = useGlobalLineageEdgeTypes()
  return ctx?.schema.lineageEdgeTypes ?? global
}

/** Root entity types for the current view's ontology. */
export function useViewRootEntityTypes(): string[] {
  const ctx = useViewExecutionContext()
  const global = useGlobalRootEntityTypes()
  return ctx?.schema.rootEntityTypes ?? global
}

/**
 * Schema loading state — inside ViewExecutionContext this is always false
 * because the context gates children behind schema readiness.
 */
export function useViewSchemaIsReady(): boolean {
  const ctx = useViewExecutionContext()
  const isLoading = useGlobalSchemaIsLoading()
  // If we're inside a ViewExecutionContext, schema is guaranteed loaded (the
  // context gates children behind schema readiness). Outside, fall back to
  // the global loading state.
  return ctx ? true : !isLoading
}

/** Returns a function to check if an edge type is a containment edge. */
export function useViewIsContainmentEdge(): (edgeType: string) => boolean {
  const types = useViewContainmentEdgeTypes()
  return (edgeType: string) => isContainmentEdgeType(edgeType, types)
}

/** Returns a function to check if an edge type is a lineage edge. */
export function useViewIsLineageEdge(): (edgeType: string) => boolean {
  const types = useViewLineageEdgeTypes()
  return (edgeType: string) => isLineageEdgeType(edgeType, types)
}

/** Entity type definition (by id) for the current view's ontology.
 *
 * Inside a view context the lookup is strictly view-scoped so node styling
 * can never bleed in from a DIFFERENT data source's ontology (the global
 * store tracks whichever scope last loaded). Outside a view context it
 * falls back to the global store selector — unchanged behavior. */
export function useViewEntityType(typeId: string): EntityTypeSchema | undefined {
  const ctx = useViewExecutionContext()
  const getGlobal = useSchemaStore((s) => s.getEntityType)
  return useMemo(() => {
    if (ctx) {
      const types = ctx.schema.entityTypes
      return (
        types.find((et) => et.id === typeId) ??
        types.find((et) => et.id.toLowerCase() === typeId.toLowerCase())
      )
    }
    return getGlobal(typeId)
  }, [ctx, getGlobal, typeId])
}

/** Visual config for an entity type, view-scoped, with the active view's
 *  per-type overrides applied (same merge as the global getEntityVisual). */
export function useViewEntityVisual(typeId: string): EntityVisualConfig | undefined {
  const ctx = useViewExecutionContext()
  const entityType = useViewEntityType(typeId)
  const getGlobalVisual = useSchemaStore((s) => s.getEntityVisual)
  const override = useSchemaStore((s) => s.getActiveView()?.entityOverrides[typeId])
  return useMemo(() => {
    if (!ctx) return getGlobalVisual(typeId)
    if (!entityType) return undefined
    return override ? { ...entityType.visual, ...override } : entityType.visual
  }, [ctx, entityType, getGlobalVisual, override, typeId])
}

/** Entity type hierarchy map for the current view's ontology. */
export function useViewEntityTypeHierarchyMap(): Record<string, { canContain: string[]; canBeContainedBy: string[] }> {
  const entityTypes = useViewEntityTypes()
  return useMemo(() => {
    if (entityTypes.length === 0) return {} as Record<string, { canContain: string[]; canBeContainedBy: string[] }>
    return Object.fromEntries(
      entityTypes.map((et) => [
        et.id,
        {
          canContain: et.hierarchy?.canContain ?? EMPTY_STRING_ARRAY,
          canBeContainedBy: et.hierarchy?.canBeContainedBy ?? EMPTY_STRING_ARRAY,
        },
      ])
    )
  }, [entityTypes])
}
