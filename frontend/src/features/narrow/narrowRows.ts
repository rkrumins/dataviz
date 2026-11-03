/**
 * Which of a column's rows a narrowed canvas keeps.
 *
 * A row stays when its entity is a member, holds members (a container on the
 * way to them), or sits anywhere inside a member whose whole inside is in scope.
 * A kept row keeps the rows above it, so a member is never drawn without its
 * parent, even when its chain was not known (`chainsCap`). A row the reader has
 * selected always stays: what they are inspecting never vanishes.
 *
 * Rows are the column's flat tree in display order (each row after its parent,
 * depth one deeper). A helper row — load more, a skeleton, the in-row search
 * box, an inline search hit — rides with the row it belongs to, and only where
 * that row's inside is in scope: paging a container whose members are all
 * loaded would only page in rows that are filtered away.
 *
 * Filtering happens on the rows, not in CSS, so the virtualizer's row count
 * and offsets collapse around what is dropped — the same as search's Isolate.
 */
import type { NarrowVisibility } from './model'

export interface NarrowRow {
  node: { id: string; urn?: string }
  depth: number
  isLoadMore?: boolean
  isFeedMore?: boolean
  isSearchBox?: boolean
  isSkeleton?: boolean
  isFailed?: boolean
  isSearchHit?: boolean
  hit?: { node: { urn: string } }
  overflow?: number
}

const COLUMN = -1   // a helper row of the column itself
const NONE = -2     // a helper row with no row to belong to

function isHelper(row: NarrowRow): boolean {
  return !!(row.isLoadMore || row.isFeedMore || row.isSearchBox || row.isSkeleton
    || row.isFailed || row.isSearchHit || row.overflow !== undefined)
}

export function narrowRows<T extends NarrowRow>(
  rows: readonly T[],
  vis: NarrowVisibility,
  isSelected: (id: string) => boolean,
): T[] {
  const kept = new Array<boolean>(rows.length).fill(false)
  // Per entity row: its inside is in scope (it holds members, or everything inside it is).
  const open = new Array<boolean>(rows.length).fill(false)
  const insideWhole = new Array<boolean>(rows.length).fill(false)
  // Per helper row: the entity row it belongs to (-1: the column's own).
  const owner = new Array<number>(rows.length).fill(-1)
  const stack: number[] = []   // entity rows above the current one

  rows.forEach((row, i) => {
    while (stack.length > 0 && rows[stack[stack.length - 1]].depth >= row.depth) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1
    if (isHelper(row)) {
      // A helper row's `node` is its owner. A column-level one (the type feed, an
      // anchored column's own "load more") sits at the top and has none.
      owner[i] = row.isFeedMore || row.depth === 0 ? COLUMN : (parent >= 0 ? parent : NONE)
      return
    }
    const key = row.node.urn ?? row.node.id
    const underWhole = parent >= 0 && (insideWhole[parent] || vis.whole.has(rows[parent].node.urn ?? rows[parent].node.id))
    insideWhole[i] = underWhole
    open[i] = underWhole || vis.whole.has(key) || vis.ancestors.has(key)
    const self = underWhole || vis.byUrn.has(key) || vis.ancestors.has(key) || isSelected(row.node.id)
    if (self) {
      kept[i] = true
      // Keep the way down to it.
      for (let s = stack.length - 1; s >= 0 && !kept[stack[s]]; s--) kept[stack[s]] = true
    }
    stack.push(i)
  })

  return rows.filter((row, i) => {
    if (!isHelper(row)) return kept[i]
    const o = owner[i]
    if (o === COLUMN) return true
    if (o === NONE || !kept[o]) return false
    // What the reader opened on a row stays with it: its search box, a failed load.
    if (row.isSearchBox || row.isFailed) return true
    if (!open[o]) return false
    if (row.isSearchHit && row.hit) {
      // An inline hit is an entity of its own: in scope, or inside what is.
      const urn = row.hit.node.urn
      return vis.byUrn.has(urn) || vis.ancestors.has(urn) || insideWhole[o]
        || vis.whole.has(rows[o].node.urn ?? rows[o].node.id)
    }
    return true
  })
}
