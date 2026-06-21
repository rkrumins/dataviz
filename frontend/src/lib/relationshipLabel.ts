/**
 * Plain-language helpers for containment relationships, shared by the create surfaces and the
 * entity drawer so the wording never drifts. Presentational only — the raw edge-type id is what's
 * stored/sent; these just make it readable for a non-technical audience.
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
