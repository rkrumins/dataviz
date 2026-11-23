/**
 * ancestryColumns — where an entity sits, as the five columns every file of entities carries.
 *
 * The trace's file wrote them first; the server's exports (a data export in every format, a view
 * file's manifest, a member set, a search's matches) write the same five, meaning the same thing
 * (`backend/common/ancestry_columns.py`): `parentUrn`, `parentName`, `parentType` (its direct
 * container, empty at the top of the graph), `path` (every container's name, from the top down to
 * its parent) and `pathUrns` (the same chain by URN).
 *
 * They are informational. They say where a row came from, so importing a file back never makes
 * them properties: a file exported with them imports exactly as it would without them.
 */

export const ANCESTRY_COLUMNS = ['parentUrn', 'parentName', 'parentType', 'path', 'pathUrns'] as const

export type AncestryColumn = (typeof ANCESTRY_COLUMNS)[number]

/** How a path is one text cell: names read `A / B`; URNs, which may hold a `/`, `a; b`. */
export const PATH_SEPARATOR = ' / '
export const URN_LIST_SEPARATOR = '; '

const fold = (header: string) => header.toLowerCase().replace(/[\s_-]+/g, '')
const FOLDED = new Set<string>(ANCESTRY_COLUMNS.map(fold))

/** Whether a file's column is one of them, however a spreadsheet or a person wrote it: any case,
 *  with or without underscores, spaces or hyphens (`parent_urn`, `Parent URN`, `PATH`). */
export function isAncestryColumn(header: string): boolean {
  return FOLDED.has(fold(header))
}
