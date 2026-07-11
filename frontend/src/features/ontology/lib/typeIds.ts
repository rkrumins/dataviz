/**
 * Type-id derivation — turn a human Display Name into the stable identifier that
 * becomes the PHYSICAL type in the graph store (FalkorDB). This is what makes edges
 * and nodes readable and index-friendly instead of opaque `rel_lx3_a1b2c3d` handles.
 *
 * Conventions (match the script-derived ontologies and FalkorDB indexing):
 *   - relationship type → edge type   → UPPER_SNAKE_CASE  ("Flows To" → FLOWS_TO)
 *   - entity type       → node label  → PascalCase        ("data source" → DataSource)
 *
 * Scope: a type id is unique WITHIN one ontology only. Two different ontologies can each
 * declare `FLOWS_TO` with different meaning — they live in separate graphs, so there is no
 * physical clash. Uniqueness is therefore always checked against the current ontology's own
 * type ids (and entity ids vs edge ids are separate namespaces — see the backend
 * ``case_insensitive_type_id_collisions``, which this mirrors).
 */

/** Strip diacritics so "Café" → "Cafe" before slugging. */
function deburr(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

/** Relationship/edge type id: UPPER_SNAKE_CASE. Idempotent. */
export function toRelationshipTypeId(input: string): string {
  return deburr(input || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase → snake boundary
    .replace(/[^a-zA-Z0-9]+/g, '_')          // any run of non-alphanumerics → one underscore
    .replace(/^_+|_+$/g, '')                 // trim underscores
    .toUpperCase()
}

/** Entity/node-label type id: PascalCase. Idempotent. Preserves already-capitalised acronyms. */
export function toEntityTypeId(input: string): string {
  const tokens = deburr(input || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // split camelCase into words
    .split(/[^a-zA-Z0-9]+/)                   // split on any non-alphanumeric run
    .filter(Boolean)
  return tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join('')
}

/**
 * Return the existing id that ``candidateId`` collides with case-insensitively, or null.
 * The caller passes the current ontology's ids for the SAME namespace, EXCLUDING the type
 * being edited (so an edit doesn't collide with itself). A non-null result means the id is
 * already taken in this ontology and the save must be blocked.
 */
export function findCaseInsensitiveCollision(
  candidateId: string,
  existingIds: Iterable<string>,
): string | null {
  const key = (candidateId || '').trim().toLowerCase()
  if (!key) return null
  for (const id of existingIds) {
    if (id && id.toLowerCase() === key) return id
  }
  return null
}
