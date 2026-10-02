/**
 * Which end of the line the relationship drawer is open on a card is — in the drawer's own words
 * (From / To; a two-way line joins two cards both ways). LineEndTag shows it.
 */
export type LineEnd = 'from' | 'to' | 'twoWay'

/** The open line's ends, as the canvas hands them to its columns. */
export type LineEnds = { from: string; to: string; twoWay: boolean }

export function lineEndOf(ends: LineEnds | null | undefined, id: string): LineEnd | undefined {
  if (!ends) return undefined
  if (ends.twoWay) return id === ends.from || id === ends.to ? 'twoWay' : undefined
  return id === ends.from ? 'from' : id === ends.to ? 'to' : undefined
}
