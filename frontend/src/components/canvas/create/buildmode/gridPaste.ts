/**
 * Pure helpers behind BuildGrid's paste: a spreadsheet block pasted into a cell lands across the
 * Grid's columns and down its rows, adding rows up to the Build limit — and says what it left out.
 * Split out of BuildGrid.tsx so they are unit-testable without React.
 */
import { makeRow, reindexDepths, type BuildRow } from './buildRow'
import { computeDownIds } from './buildGridSelection'

/**
 * The Build limit: the most rows the Grid holds. A paste adds rows for its extra lines up to it and
 * says what it left out. As many as one Duplicate stages (`DUPLICATE_MAX`) — a batch the save
 * reconciles in one pass.
 */
export const BUILD_ROW_LIMIT = 2000

/** The Grid's columns in the order it shows them: where a tab-separated paste's cells land, from
 *  the column pasted into rightward. */
export const GRID_COLUMNS = ['name', 'type', 'parent', 'layer', 'description'] as const
export type GridColumn = (typeof GRID_COLUMNS)[number]

export interface GridPaste {
  /** Each pasted line's cells, by the row it lands in: the row pasted into and the editable rows
   *  below it, then the rows the paste adds (`added`). */
  rows: Array<{ id: string; cells: Partial<Record<GridColumn, string>> }>
  /** Ids for the rows the paste adds — fresh, after the last row it fills. */
  added: string[]
  /** Lines past the Build limit, not pasted. */
  skippedLines: number
  /** Non-empty cells past the Grid's last column, not pasted. */
  skippedCells: number
}

/**
 * Lay a clipboard block onto the Grid, the way a spreadsheet pastes: lines on newlines (the one a
 * spreadsheet copy ends with ignored), cells on tabs, each line's cells across the columns from
 * `column`. Lines go to the rows from `startId` down (`ids`: the editable rows, in display order),
 * then to new rows while the Grid holds fewer than `limit` — what is left out is counted, never
 * dropped silently. Null for a single plain cell: the input takes that as typed.
 */
export function planGridPaste(
  text: string,
  at: { ids: string[]; startId: string; column: GridColumn; rowCount: number; limit?: number; mintId?: () => string },
): GridPaste | null {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 1 && !lines[0].includes('\t')) return null
  const from = GRID_COLUMNS.indexOf(at.column)
  let skippedCells = 0
  const cells = lines.map((line) => {
    const out: Partial<Record<GridColumn, string>> = {}
    line.split('\t').forEach((value, i) => {
      const col = GRID_COLUMNS[from + i]
      if (col) out[col] = value
      else if (value.trim()) skippedCells++
    })
    return out
  })
  const existing = computeDownIds(at.ids, at.startId, cells.length)
  const room = Math.max(0, (at.limit ?? BUILD_ROW_LIMIT) - at.rowCount)
  const landing = Math.min(cells.length, existing.length + room)
  const mintId = at.mintId ?? (() => crypto.randomUUID())
  const added = Array.from({ length: Math.max(0, landing - existing.length) }, mintId)
  const ids = [...existing, ...added]
  return {
    rows: cells.slice(0, landing).map((c, i) => ({ id: ids[i], cells: c })),
    added,
    skippedLines: cells.length - landing,
    skippedCells,
  }
}

/**
 * The Grid's rows with a paste applied, in one pass. Name and Description take their cells as
 * pasted; Type, Parent and Layer are picked, so a cell there counts only when it names one here —
 * a type (by name or id), a row by its name (never the row itself or one beneath it: a loop), a
 * layer — and an empty one leaves the row's as it was. The rows the paste adds follow the last row
 * it fills, beside it. `unmatched`: the cells that named nothing, left out.
 */
export function applyGridPaste(
  rows: BuildRow[],
  paste: GridPaste,
  names: { typeId: (value: string) => string | undefined; layerId: (value: string) => string | undefined },
): { rows: BuildRow[]; unmatched: number } {
  const filled = paste.rows.length - paste.added.length   // lines that land in rows already there
  const lastFilled = rows.find((r) => r.id === paste.rows[filled - 1]?.id)
  const next = [
    ...rows.map((r) => ({ ...r })),
    ...paste.added.map((id) => makeRow({ id, parentId: lastFilled?.parentId ?? null })),
  ]
  const byId = new Map(next.map((r) => [r.id, r]))
  // Names first, so a Parent cell can name a row the paste itself named, on a line above or below.
  for (const { id, cells } of paste.rows) {
    const row = byId.get(id)!
    if (cells.name !== undefined) row.name = cells.name
    if (cells.description !== undefined) row.description = cells.description
  }
  const byName = new Map<string, string>()
  for (const r of next) {
    const key = r.name.trim().toLowerCase()
    if (key && !byName.has(key)) byName.set(key, r.id)
  }
  const isAncestorOrSelf = (candidate: string, of: string) => {
    for (let cur: string | null | undefined = of, n = 0; cur && n <= next.length; cur = byId.get(cur)?.parentId, n++) {
      if (cur === candidate) return true
    }
    return false
  }
  let unmatched = 0
  for (const { id, cells } of paste.rows) {
    const row = byId.get(id)!
    const type = cells.type?.trim()
    if (type) {
      const typeId = names.typeId(type)
      if (typeId) row.typeId = typeId
      else unmatched++
    }
    const parent = cells.parent?.trim()
    if (parent) {
      const parentId = byName.get(parent.toLowerCase())
      if (parentId && !isAncestorOrSelf(id, parentId)) row.parentId = parentId
      else unmatched++
    }
    const layer = cells.layer?.trim()
    if (layer) {
      const layerId = names.layerId(layer)
      if (layerId) row.layerId = layerId
      else unmatched++
    }
  }
  return { rows: reindexDepths(next), unmatched }
}
