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

export function insertSiblingAfter(rows: BuildRow[], afterId: string, row: BuildRow): BuildRow[] {
  const anchor = rows.find(r => r.id === afterId)
  const newRow: BuildRow = { ...row, parentId: anchor ? anchor.parentId : null }
  const index = rows.findIndex(r => r.id === afterId)
  if (index === -1) return [...rows, newRow]
  return [...rows.slice(0, index + 1), newRow, ...rows.slice(index + 1)]
}

export function insertChildOf(rows: BuildRow[], parentId: string, row: BuildRow): BuildRow[] {
  const newRow: BuildRow = { ...row, parentId }
  const parentIndex = rows.findIndex(r => r.id === parentId)
  if (parentIndex === -1) return [...rows, newRow]
  // insert after the parent's last existing descendant, or right after the parent
  const kids = childrenOf(rows, parentId)
  const lastChild = kids[kids.length - 1]
  const insertAfterId = lastChild ? lastChild.id : parentId
  const insertIndex = rows.findIndex(r => r.id === insertAfterId)
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
