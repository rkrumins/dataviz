/**
 * Drawn-edge count — how many connection lines the Context View overlay is
 * actually painting right now, published by LineageFlowOverlay from its
 * IntersectionObserver-gated `computedEdges` set (see rowEquality.ts) and
 * read by ConnectionsPanel's header ("N drawn").
 *
 * A dedicated store (not canvas state), same reason as `columnPeriphery.ts`:
 * overlay emissions must re-render only the panel that reads this number,
 * never the multi-thousand-line canvas.
 */
import { create } from 'zustand'

interface DrawnEdgesState {
  drawn: number
  setDrawn: (n: number) => void
}

export const useDrawnEdgesStore = create<DrawnEdgesState>((set) => ({
  drawn: 0,
  setDrawn: (drawn) => set((s) => (s.drawn === drawn ? s : { drawn })),
}))
