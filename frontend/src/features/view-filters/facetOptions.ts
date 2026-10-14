/**
 * Options from one place, counts from another.
 *
 * A filter's options have to stay put while its counts move: if Tag listed only
 * the tags that still match, picking one would make the others vanish, and there
 * would be no way to see that a choice leads nowhere. So the options come from
 * the UNIVERSE — everything the reader can see, unfiltered — and each one's count
 * from the facets computed with the other filters applied. A GROUP BY never
 * returns a row for zero, so an option the filtered facets don't mention counts
 * 0: that is the only way a dead end can show at all.
 */

export interface Counted<T> {
  option: T
  /** Views this option would leave given the other filters; `undefined` while
   *  the counts are still loading, so nothing is dimmed on a guess. */
  count: number | undefined
}

/**
 * The universe's options in their own (stable) order, plus any selected id the
 * universe doesn't list — a selection must never disappear from its own menu —
 * each with its live count.
 */
export function withCounts<T>(
  universe: readonly T[],
  idOf: (option: T) => string,
  counts: ReadonlyMap<string, number> | null,
  selected: readonly string[] = [],
  missing?: (id: string) => T,
): Counted<T>[] {
  const ids = new Set(universe.map(idOf))
  const extra = missing
    ? selected.filter(id => !ids.has(id)).map(missing)
    : []
  return [...universe, ...extra].map(option => ({
    option,
    count: counts ? (counts.get(idOf(option)) ?? 0) : undefined,
  }))
}

/** A facet list as a lookup from value to count. */
export function countMap<T>(
  rows: readonly T[] | null | undefined,
  key: (row: T) => string,
  count: (row: T) => number,
): Map<string, number> | null {
  if (!rows) return null
  return new Map(rows.map(r => [key(r), count(r)]))
}
