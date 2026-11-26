/**
 * What a view's health check asks about top-level entities it doesn't place (`POST
 * /nodes/top-level/unplaced`): the ontology's root types the view is ABOUT — a type it places
 * entities of, or a column is for — and, of those, the entities it places. An open view's type
 * layers already load every entity of the types they claim, so those types are never asked about:
 * nothing there is left out.
 */
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { isTempUrn } from './assignmentMutations'

const fold = (t: string) => t.toLowerCase()

export function rootTypesToCheck({ rootTypes, layers, placedTypes, fedTypes }: {
  /** The ontology's root entity types. */
  rootTypes: readonly string[]
  layers: readonly Pick<ViewLayerConfig, 'entityTypes'>[]
  /** The types of the entities the view places (as loaded). */
  placedTypes: Iterable<string>
  /** The types an open view's type layers load by rule; none in a curated view. */
  fedTypes: readonly string[]
}): string[] {
  const about = new Set([...placedTypes, ...layers.flatMap((l) => l.entityTypes ?? [])].map(fold))
  const fed = new Set(fedTypes.map(fold))
  return rootTypes.filter((t) => about.has(fold(t)) && !fed.has(fold(t)))
}

/** The urns the view places whose entity is of one of `types` — never a temp urn. Sorted. */
export function placedOfTypes(
  assignments: Record<string, LayerAssignmentEntry>,
  typeOf: (urn: string) => string | undefined,
  types: readonly string[],
): string[] {
  const asked = new Set(types.map(fold))
  return Object.keys(assignments)
    .filter((urn) => assignments[urn]?.layerId && !isTempUrn(urn) && asked.has(fold(typeOf(urn) ?? '')))
    .sort()
}
