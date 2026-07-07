/**
 * Pure helpers backing BuildGrid's selection + paste-into-cell + parent
 * typeahead. Split out of BuildGrid.tsx so these are unit-testable without
 * React (mirrors buildOutlineOutdent.ts's split for the same reason).
 */
import type { BuildRow } from './buildRow'

/**
 * Shift-click range selection: every id between `anchorId` and `targetId`
 * (inclusive), in `displayIds` order — the same order BuildGrid renders rows
 * in, so a shift-click always selects exactly the visually contiguous rows.
 * Falls back to `[targetId]` if either id isn't found (e.g. the anchor row
 * was removed since it was last clicked).
 */
export function computeRangeIds(displayIds: string[], anchorId: string, targetId: string): string[] {
  const anchorIdx = displayIds.indexOf(anchorId)
  const targetIdx = displayIds.indexOf(targetId)
  if (anchorIdx === -1 || targetIdx === -1) return [targetId]
  const [start, end] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
  return displayIds.slice(start, end + 1)
}

/**
 * Up to `count` row ids starting at `startId` (inclusive), in `displayIds`
 * order — aligns a multi-line clipboard paste (BuildGrid's paste-into-cell)
 * to the rows beneath the cell that was pasted into. Returns `[]` if
 * `startId` isn't found; naturally clamps at the end of `displayIds`.
 */
export function computeDownIds(displayIds: string[], startId: string, count: number): string[] {
  const start = displayIds.indexOf(startId)
  if (start === -1) return []
  return displayIds.slice(start, start + count)
}

/**
 * All descendant ids of `id` (children, grandchildren, ...) within `rows` —
 * used to keep BuildGrid's Parent typeahead from offering a choice that
 * would make a row its own descendant's child (a cycle).
 */
export function descendantIds(rows: BuildRow[], id: string): Set<string> {
  const result = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const r of rows) {
      if (r.parentId != null && (r.parentId === id || result.has(r.parentId)) && !result.has(r.id)) {
        result.add(r.id)
        changed = true
      }
    }
  }
  return result
}
