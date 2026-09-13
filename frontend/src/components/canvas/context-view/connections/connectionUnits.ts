/**
 * The vocabulary for lineage counts: one word for the KIND, three for the UNIT.
 *
 * KIND. A lineage relationship is a FLOW — it has a direction, and the
 * direction is the whole point. A structural one ("this table is inside that
 * database") is NOT a flow and must never be called one; the covering word
 * for a surface that can show both is "relationship". Every surface that
 * imports this module is lineage-only by construction — `useEdgeProjection`
 * drops `isContainmentEdge` in all three of its sections,
 * `lib/lineage-neighbors` excludes containment by contract, and
 * `useExternalDegrees` asks the server for lineage types only — so all of
 * them say flow, and none of them needs the covering word.
 *
 * UNIT. Five surfaces count flows and five of them mean something different
 * — and they are all right. A rolled-up line standing for 4,300 table-level
 * flows is one line, 4,300 flows, and one neighbour; a reader who sees 4,300
 * in the panel and 1 on the card is not looking at a bug. What was missing
 * is the noun: every count said "connections" and none said which of the
 * three things it was counting.
 *
 * So there are exactly three units, and every surface names the one it
 * shows — in its visible text where there is room, in an adjacent tooltip
 * where there is not. The words live HERE and nowhere else, so the surfaces
 * cannot drift apart again.
 *
 * "Connection" carried neither kind nor unit, and is retired from this
 * lane's copy.
 *
 * Pure strings: no React, no store, no schema.
 */

export type ConnectionCountUnit = 'flows' | 'lines' | 'neighbors'

interface UnitWords {
  /** Noun phrase for exactly one. */
  one: string
  /** Noun phrase for none, or for more than one. */
  many: string
  /** One sentence saying precisely what is being counted. Tooltip prose. */
  meaning: string
}

export const CONNECTION_COUNT_UNITS: Record<ConnectionCountUnit, UnitWords> = {
  flows: {
    one: 'underlying flow',
    many: 'underlying flows',
    meaning:
      'Underlying flows: every flow in the data, counted one by one — a bundled line contributes all of the flows it stands for.',
  },
  lines: {
    one: 'line',
    many: 'lines',
    meaning:
      'Lines: one per line between two cards on the canvas, however many underlying flows that line stands for.',
  },
  neighbors: {
    one: 'connected entity',
    many: 'connected entities',
    meaning:
      'Connected entities: one per neighbor and kind of flow — a neighbor reached by two kinds of flow counts twice.',
  },
}

/** The unit's noun, agreeing with `count`. */
export function unitNoun(count: number, unit: ConnectionCountUnit): string {
  const words = CONNECTION_COUNT_UNITS[unit]
  return count === 1 ? words.one : words.many
}

/** `"4,300 underlying flows"` — the number and its unit, together. */
export function formatUnitCount(count: number, unit: ConnectionCountUnit): string {
  return `${count.toLocaleString()} ${unitNoun(count, unit)}`
}

/** The sentence a tooltip shows when the noun alone is not enough. */
export function unitMeaning(unit: ConnectionCountUnit): string {
  return CONNECTION_COUNT_UNITS[unit].meaning
}
