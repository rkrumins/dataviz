/**
 * The children each parent holds that the graph still has, to weigh against its childCount.
 *
 * Tombstones (deleted entities a draft or comparison draws where they were) nest under their old
 * parents like children, but the graph no longer has them. Counted as loaded, they stand in for a
 * page that never loaded: an anchor's "N more" falls short, the lineage aggregation skips a parent
 * still holding unloaded children, and a sort flip re-sorts a partial page as if it were whole.
 *
 * The same map comes back while no tombstone is drawn, so memos keyed on it don't churn.
 */
export function withoutTombstones(
  childMap: Map<string, string[]>,
  isTombstone: (id: string) => boolean,
): Map<string, string[]> {
  let out: Map<string, string[]> | null = null
  for (const [parent, kids] of childMap) {
    if (!kids.some(isTombstone)) continue
    out ??= new Map(childMap)
    out.set(parent, kids.filter((id) => !isTombstone(id)))
  }
  return out ?? childMap
}
