/**
 * buildRowsStore — the working `BuildRow[]` for the Build surface (outline/grid/paste
 * adapters mutate it directly). Kept separate from `hierarchyBuilderStore` (open/scope)
 * for single responsibility: this store owns row data, not panel visibility.
 *
 * Every mutation delegates to the pure `buildRow.ts` functions, then `reindexDepths`,
 * so `depth` never drifts from the `parentId` chain.
 */
import { create } from 'zustand'
import {
  type BuildRow,
  makeRow,
  insertChildOf,
  insertSiblingAfter,
  removeRow as removeRowPure,
  duplicateSubtree,
  reindexDepths,
} from './buildRow'

interface BuildRowsState {
  rows: BuildRow[]
  setRows: (rows: BuildRow[]) => void
  addSibling: (afterId: string) => void
  addChild: (parentId: string) => void
  updateRow: (id: string, patch: Partial<BuildRow>) => void
  removeRow: (id: string) => void
  /** Sets (or clears, when `layerId` is `undefined`) a row's Grid Layer override. */
  setRowLayer: (id: string, layerId: string | undefined) => void
  /** Clones a row's whole subtree (fresh ids) as a sibling block after the original. */
  duplicateRowSubtree: (id: string) => void
  reset: () => void
}

export const useBuildRowsStore = create<BuildRowsState>((set) => ({
  rows: [],

  setRows: (rows) => set({ rows: reindexDepths(rows) }),

  addSibling: (afterId) =>
    set((s) => ({
      rows: reindexDepths(insertSiblingAfter(s.rows, afterId, makeRow({ id: crypto.randomUUID() }))),
    })),

  addChild: (parentId) =>
    set((s) => ({
      rows: reindexDepths(insertChildOf(s.rows, parentId, makeRow({ id: crypto.randomUUID() }))),
    })),

  updateRow: (id, patch) =>
    set((s) => ({
      rows: reindexDepths(s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    })),

  removeRow: (id) => set((s) => ({ rows: reindexDepths(removeRowPure(s.rows, id)) })),

  setRowLayer: (id, layerId) =>
    set((s) => ({
      rows: s.rows.map((r) => (r.id === id ? { ...r, layerId } : r)),
    })),

  duplicateRowSubtree: (id) =>
    set((s) => ({
      rows: reindexDepths(duplicateSubtree(s.rows, id)),
    })),

  reset: () => set({ rows: [] }),
}))
