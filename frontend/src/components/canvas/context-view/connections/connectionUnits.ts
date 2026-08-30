/**
 * The unit vocabulary for connection counts.
 *
 * Five surfaces count "connections" and five of them mean something
 * different — and they are all right. A rolled-up line standing for 4,300
 * table-level flows is one line, 4,300 relationships, and one neighbour; a
 * reader who sees 4,300 in the panel and 1 on the card is not looking at a
 * bug. What was missing is the noun: every count said "connections" and
 * none said which of the three things it was counting.
 *
 * So there are exactly three units, and every surface names the one it
 * shows — in its visible text where there is room, in an adjacent tooltip
 * where there is not. The words live HERE and nowhere else, so the surfaces
 * cannot drift apart again.
 *
 * Pure strings: no React, no store, no schema.
 */

export type ConnectionCountUnit = 'relationships' | 'lines' | 'neighbors'

interface UnitWords {
  /** Noun phrase for exactly one. */
  one: string
  /** Noun phrase for none, or for more than one. */
  many: string
  /** One sentence saying precisely what is being counted. Tooltip prose. */
  meaning: string
}

export const CONNECTION_COUNT_UNITS: Record<ConnectionCountUnit, UnitWords> = {
  relationships: {
    one: 'underlying relationship',
    many: 'underlying relationships',
    meaning:
      'Underlying relationships: every relationship in the data, counted one by one — a bundled line contributes all of the relationships it stands for.',
  },
  lines: {
    one: 'line',
    many: 'lines',
    meaning:
      'Lines: one per line between two cards on the canvas, however many underlying relationships that line stands for.',
  },
  neighbors: {
    one: 'connected entity',
    many: 'connected entities',
    meaning:
      'Connected entities: one per neighbor and kind of relationship — a neighbor reached by two kinds of relationship counts twice.',
  },
}

/** The unit's noun, agreeing with `count`. */
export function unitNoun(count: number, unit: ConnectionCountUnit): string {
  const words = CONNECTION_COUNT_UNITS[unit]
  return count === 1 ? words.one : words.many
}

/** `"4,300 underlying relationships"` — the number and its unit, together. */
export function formatUnitCount(count: number, unit: ConnectionCountUnit): string {
  return `${count.toLocaleString()} ${unitNoun(count, unit)}`
}

/** The sentence a tooltip shows when the noun alone is not enough. */
export function unitMeaning(unit: ConnectionCountUnit): string {
  return CONNECTION_COUNT_UNITS[unit].meaning
}
