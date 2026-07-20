/**
 * Column periphery summaries — per-layer counts of connections whose
 * partners are scrolled beyond the column's fold, computed by the edge
 * overlay (it owns visibility truth) and consumed by each LayerColumn's
 * merged "↑ N rows · M connections" periphery chips.
 *
 * A dedicated store (not canvas state) so overlay emissions re-render
 * ONLY the columns whose numbers changed — never the 3k-line canvas.
 * That indirection is what killed the emit → canvas re-render → observer
 * churn feedback loop class for the Anchor Rail; the periphery reuses
 * the same shape from the start.
 */
import { create } from 'zustand'

export type ColumnPeripherySummary = {
  /** Connections from visible entities to partners above/below this
   *  column's fold, and the distinct partner entities they lead to. */
  upEdges: number
  upEntities: number
  /** Sample of partner node ids above the fold (capped) — the chips'
   *  hover panel names them; they live in THIS column so the column
   *  resolves display names locally. */
  upPartnerIds: string[]
  downEdges: number
  downEntities: number
  downPartnerIds: string[]
}

/** Cap on named partners carried per direction (tooltip sample size). */
export const PERIPHERY_PARTNER_CAP = 8

interface ColumnPeripheryState {
  summaries: Record<string, ColumnPeripherySummary>
  setSummaries: (summaries: Record<string, ColumnPeripherySummary>) => void
  clear: () => void
}

export const useColumnPeripheryStore = create<ColumnPeripheryState>((set) => ({
  summaries: {},
  setSummaries: (summaries) => set({ summaries }),
  clear: () => set({ summaries: {} }),
}))
