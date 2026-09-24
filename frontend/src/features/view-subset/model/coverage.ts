/**
 * What a set of picks covers on the canvas: each picked row, and — for a pick
 * that takes in what sits beneath it — every loaded row beneath it, down to
 * any deeper pick that does not (the same rule the view applies: the nearest
 * pick above a row decides whether the subset holds it). Covered rows stay
 * lit while the studio dims the rest.
 */
import type { SubsetPick } from './studioStore'

export function coveredRows(
  picks: readonly SubsetPick[],
  childMap: ReadonlyMap<string, readonly string[]>,
  rowOf: (urn: string) => string,
): Set<string> {
  const pickByRow = new Map(picks.map(p => [rowOf(p.urn), p]))
  const covered = new Set<string>(pickByRow.keys())
  const stack = [...pickByRow].filter(([, p]) => p.inheritsChildren).map(([row]) => row)
  const descended = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (descended.has(id)) continue
    descended.add(id)
    for (const child of childMap.get(id) ?? []) {
      covered.add(child)
      // A deeper pick that leaves out what sits beneath it stops the descent.
      if (pickByRow.get(child)?.inheritsChildren === false) continue
      stack.push(child)
    }
  }
  return covered
}

/**
 * The pick that already covers a row through an ancestor, if any: the nearest
 * picked ancestor, when it takes in what sits beneath it. Picking such a row
 * again would change nothing the reader can see.
 */
export function coveringAncestor(
  rowId: string,
  picksByRow: ReadonlyMap<string, SubsetPick>,
  parentMap: ReadonlyMap<string, string>,
): SubsetPick | undefined {
  let at = parentMap.get(rowId)
  const guard = new Set<string>()
  while (at && !guard.has(at)) {
    guard.add(at)
    const pick = picksByRow.get(at)
    if (pick) return pick.inheritsChildren ? pick : undefined
    at = parentMap.get(at)
  }
  return undefined
}
