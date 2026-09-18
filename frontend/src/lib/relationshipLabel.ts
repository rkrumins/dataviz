/**
 * Plain-language helpers for relationships, shared by the create surfaces, the entity drawer and
 * every surface that names an edge type, so the wording never drifts. Presentational only — the
 * raw edge-type id is what's stored/sent; these just make it readable for a non-technical audience.
 */

/** Humanize a containment relationship id (e.g. `partOf` → "Part of", `BELONGS_TO` → "Belongs to"). */
export function relationshipLabel(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/**
 * The phrase describing where an entity sits, read from the CHILD's perspective — what a
 * non-technical viewer sees in the entity details ("Part of Sales"). Containment edges are stored
 * parent→child with various types; from the child's side they nearly all read as "Part of", with
 * "belongs to"-style types kept distinct because that wording is meaningful to users.
 */
export function parentPlacementPhrase(edgeType?: string | null): string {
  const norm = (edgeType ?? '').toUpperCase()
  if (norm.includes('BELONG')) return 'Belongs to'
  return 'Part of'
}

/**
 * Wording this app owns for edge types whose stored ontology definition it cannot restate.
 *
 * `AGGREGATED` is written by the aggregation worker and seeded into every data source's ontology
 * as "Aggregated" / "A synthetic aggregated lineage edge computed from column-level lineage." —
 * engineer-speak, and add-only, so rewording the seed would never reach a data source that already
 * exists. The database keeps its value; this module owns the word.
 */
export const EDGE_TYPE_COPY: Readonly<Record<string, { label: string; description: string }>> = {
  AGGREGATED: {
    label: 'Combined flow',
    description: 'Many detailed flows between two items, shown as one connection.',
  },
}

/** This app's wording for an edge type id, or null when it has no opinion and the ontology's own
 *  name should stand. Case-insensitive on the id. */
export function edgeTypeCopy(id: string): { label: string; description: string } | null {
  return EDGE_TYPE_COPY[id.toUpperCase()] ?? null
}
