import { descendantIds } from './buildGridSelection'

export interface BuildFix { field: 'type' | 'parent' | 'promote'; note: string }
export interface BuildIssue { message: string }
export interface BuildRow {
  id: string                 // stable client id
  name: string
  typeId: string | null
  parentId: string | null    // another BuildRow.id, or null for a root
  depth: number              // derived from parent chain
  description?: string
  tags?: string[]
  properties?: Record<string, unknown>
  /** Explicit per-row Layer override (Grid Task 2) — wins over the
   *  type-derived auto-by-type target in `resolveRowLayer`. Absent/`undefined`
   *  means "use auto-by-type". */
  layerId?: string
  status: 'valid' | 'fixed' | 'error'
  issues: BuildIssue[]
  fixes: BuildFix[]
}

export function makeRow(partial: { id: string; name?: string; typeId?: string | null; parentId?: string | null }): BuildRow {
  return {
    id: partial.id,
    name: partial.name ?? '',
    typeId: partial.typeId ?? null,
    parentId: partial.parentId ?? null,
    depth: 0,
    status: 'valid',
    issues: [],
    fixes: [],
  }
}

// recompute depth from parentId chains; guards against cycles with a visited set, capped at rows.length
export function reindexDepths(rows: BuildRow[]): BuildRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  const depthOf = (id: string): number => {
    let depth = 0
    let current = byId.get(id)
    const visited = new Set<string>()
    while (current?.parentId != null) {
      if (visited.has(current.id) || visited.size >= rows.length) break
      visited.add(current.id)
      const parent = byId.get(current.parentId)
      if (!parent) break
      depth++
      current = parent
    }
    return depth
  }
  return rows.map(r => ({ ...r, depth: depthOf(r.id) }))
}

// The array index of the LAST node in `id`'s subtree (the node itself + all
// descendants). Insertions use this so a new row lands after the anchor's whole
// subtree, keeping the flat array in valid outline order (a node's descendants
// always immediately follow it) — otherwise a new depth-1 child could land
// between a node and its own children.
function lastSubtreeIndex(rows: BuildRow[], id: string): number {
  const subtree = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const r of rows) {
      if (r.parentId != null && subtree.has(r.parentId) && !subtree.has(r.id)) {
        subtree.add(r.id)
        changed = true
      }
    }
  }
  let last = -1
  rows.forEach((r, i) => { if (subtree.has(r.id)) last = i })
  return last
}

export function insertSiblingAfter(rows: BuildRow[], afterId: string, row: BuildRow): BuildRow[] {
  const anchor = rows.find(r => r.id === afterId)
  const newRow: BuildRow = { ...row, parentId: anchor ? anchor.parentId : null }
  if (!anchor) return [...rows, newRow]
  // after the anchor's full subtree, so the new sibling follows the anchor's descendants
  const insertIndex = lastSubtreeIndex(rows, afterId)
  return [...rows.slice(0, insertIndex + 1), newRow, ...rows.slice(insertIndex + 1)]
}

export function insertChildOf(rows: BuildRow[], parentId: string, row: BuildRow): BuildRow[] {
  const newRow: BuildRow = { ...row, parentId }
  if (rows.findIndex(r => r.id === parentId) === -1) return [...rows, newRow]
  // after the parent's full existing subtree, so the new child becomes the last
  // child and lands after every existing descendant (valid outline order)
  const insertIndex = lastSubtreeIndex(rows, parentId)
  return [...rows.slice(0, insertIndex + 1), newRow, ...rows.slice(insertIndex + 1)]
}

// reparent to grandparent
export function outdent(rows: BuildRow[], id: string): BuildRow[] {
  const row = rows.find(r => r.id === id)
  if (!row || row.parentId == null) return rows
  const parent = rows.find(r => r.id === row.parentId)
  const grandparentId = parent ? parent.parentId : null
  return rows.map(r => (r.id === id ? { ...r, parentId: grandparentId } : r))
}

// removes the row and its descendants
export function removeRow(rows: BuildRow[], id: string): BuildRow[] {
  const toRemove = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const r of rows) {
      if (r.parentId != null && toRemove.has(r.parentId) && !toRemove.has(r.id)) {
        toRemove.add(r.id)
        changed = true
      }
    }
  }
  return rows.filter(r => !toRemove.has(r.id))
}

export function childrenOf(rows: BuildRow[], id: string | null): BuildRow[] {
  return rows.filter(r => r.parentId === id)
}

// Clones `id`'s whole subtree (the row + every descendant, via `descendantIds`)
// with FRESH ids, re-threads each clone's parentId to its cloned parent (the
// root clone keeps the ORIGINAL's parentId, so it lands as a sibling of the
// original), and inserts the clone block right after the original's whole
// subtree (same `lastSubtreeIndex` anchor `insertSiblingAfter`/`insertChildOf`
// use, so the result stays in valid outline order). `mintId` is injected
// (defaulting to the same `crypto.randomUUID()` the store uses elsewhere) so
// this stays pure/testable: a deterministic `mintId` makes the clone ids
// predictable in tests without this function reaching for global state itself.
export function duplicateSubtree(
  rows: BuildRow[],
  id: string,
  mintId: () => string = () => crypto.randomUUID(),
): BuildRow[] {
  const anchor = rows.find(r => r.id === id)
  if (!anchor) return rows
  const subtreeIds = new Set([id, ...descendantIds(rows, id)])
  const subtreeRows = rows.filter(r => subtreeIds.has(r.id)) // preserves original order
  const idMap = new Map(subtreeRows.map(r => [r.id, mintId()]))
  const clones: BuildRow[] = subtreeRows.map(r => ({
    ...r,
    id: idMap.get(r.id)!,
    parentId: r.id === id ? anchor.parentId : (idMap.get(r.parentId!) ?? r.parentId),
  }))
  const insertIndex = lastSubtreeIndex(rows, id)
  return [...rows.slice(0, insertIndex + 1), ...clones, ...rows.slice(insertIndex + 1)]
}
