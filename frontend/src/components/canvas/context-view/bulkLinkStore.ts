/**
 * bulkLinkStore — the one state behind every way of linking a selection:
 * the Link panel (the selection bar's "Link…"), the card a drag drops at its
 * drop point, and picking the other side by clicking cards on the canvas.
 * One state, so "More options…" on the card opens the panel exactly as the
 * reader left it, and a card clicked on the canvas lands in whichever
 * surface is open.
 *
 * The selection itself stays in the canvas store: it is one side of every
 * link. This holds the rest — which way the data flows, the other side, the
 * relationship the reader chose.
 */
import { create } from 'zustand'
import type { BulkDirection } from '@/lib/bulkLinks'

export type BulkLinkSurface = 'card' | 'panel'

interface BulkLinkState {
  /** Which surface is open; null = none. */
  surface: BulkLinkSurface | null
  direction: BulkDirection
  /** The other side, in the order it was picked. */
  picked: string[]
  /** The relationship the reader chose; null = the best fit. */
  chosenType: string | null
  /** Where a dropped link's card floats (viewport coordinates). */
  anchor: { x: number; y: number } | null
  /** Clicking a card on the canvas adds it to — or takes it off — the other side. */
  pickingOnCanvas: boolean

  /** The Link panel, from scratch. */
  openPanel: () => void
  /** The card a drag drops: direction and the first of the other side come from the drag. */
  openCard: (opts: { direction: BulkDirection; picked: string[]; anchor: { x: number; y: number } }) => void
  /** From the card to the full panel, keeping everything. */
  expandToPanel: () => void
  swap: () => void
  togglePicked: (id: string) => void
  setChosenType: (edgeType: string | null) => void
  setPickingOnCanvas: (on: boolean) => void
  close: () => void
}

const CLOSED = {
  surface: null,
  direction: 'selection-feeds' as BulkDirection,
  picked: [] as string[],
  chosenType: null,
  anchor: null,
  pickingOnCanvas: false,
}

export const useBulkLinkStore = create<BulkLinkState>((set) => ({
  ...CLOSED,

  openPanel: () => set({ ...CLOSED, surface: 'panel' }),
  openCard: ({ direction, picked, anchor }) => set({ ...CLOSED, surface: 'card', direction, picked, anchor }),
  expandToPanel: () => set({ surface: 'panel', pickingOnCanvas: false }),
  swap: () => set((s) => ({ direction: s.direction === 'selection-feeds' ? 'feeds-selection' : 'selection-feeds' })),
  togglePicked: (id) =>
    set((s) => ({ picked: s.picked.includes(id) ? s.picked.filter((p) => p !== id) : [...s.picked, id] })),
  setChosenType: (chosenType) => set({ chosenType }),
  setPickingOnCanvas: (pickingOnCanvas) => set({ pickingOnCanvas }),
  close: () => set(CLOSED),
}))
