/**
 * ontologyPreflightService — pure helpers over the ontology preflight options
 * (`allowed-children` / `allowed-edges`). The fetching lives on the provider
 * (branch + dataSource scoped via buildUrl); this module owns the *policy* the
 * UI applies on top of those raw options.
 */
import type { AllowedEdgeOption } from '@/providers/GraphDataProvider'

export type { AllowedChildOption, AllowedEdgeOption, EdgeDirection } from '@/providers/GraphDataProvider'

/**
 * Edge types a user must NEVER draw by hand. `AGGREGATED` is synthetic — it is
 * materialized by the background rollup job after a draft is published, never
 * authored. (It is flagged `is_lineage`, so it leaks into `lineageEdgeTypes`
 * and has to be excluded explicitly.)
 */
export const NON_DRAWABLE_EDGE_TYPES = new Set<string>(['AGGREGATED'])

/**
 * The raw lineage edge types a user may actually draw between two entities:
 * the preflight options intersected with the view's lineage edge types, minus
 * the synthetic/non-drawable ones. Disallowed options are KEPT (the picker
 * shows them disabled with a reason) — only non-lineage and synthetic types
 * are dropped entirely.
 */
export function selectDrawableLineageEdges(
  options: AllowedEdgeOption[],
  lineageEdgeTypes: string[],
): AllowedEdgeOption[] {
  const lineage = new Set(lineageEdgeTypes)
  return options.filter(
    (o) => lineage.has(o.edgeType) && !NON_DRAWABLE_EDGE_TYPES.has(o.edgeType),
  )
}
