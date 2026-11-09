/**
 * What a past revision reads as it was and what it leaves off, said the same wherever it is said:
 * the banner, a search box, a menu item that is off.
 */
export const AT_REVISION_READS =
  "Name search and lineage traces read the graph as it was. Advanced search, display rules, subset views, Narrow and rolled-up traces read it as it is now, so they're off here."

/** The one-line form, for a control that is off at a revision. */
export const OFF_AT_REVISION = 'Reads the graph as it is now — off at a past revision'

/** Published has revisions past the head an open revision's "since then" counts up to. */
export function movedOn(newer: number): string {
  return `Published has moved on: ${newer.toLocaleString()} newer ${newer === 1 ? 'revision' : 'revisions'}`
}
