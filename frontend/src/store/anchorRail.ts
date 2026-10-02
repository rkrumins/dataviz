/**
 * The Anchor Rail — proxy chips docked in each column for the focused
 * entity's partners scrolled out of sight. The edge overlay decides the focus
 * (the selection at once, a hovered entity after a short dwell) and the chips;
 * each LayerColumn reads its own.
 *
 * A store rather than canvas state for the same reason as columnPeriphery: the
 * rail follows the pointer, and as canvas state every dwell re-rendered the
 * whole canvas — every column and every row — to move a handful of chips.
 */
import { create } from 'zustand'
import type { AnchorProxyGroup } from '@/components/canvas/context-view/types'

interface AnchorRailState {
  /** Whose partners the chips stand for, or null when the rail is empty. */
  focusId: string | null
  groups: ReadonlyMap<string, AnchorProxyGroup>
  publish: (groups: ReadonlyMap<string, AnchorProxyGroup>, focusId: string | null) => void
  clear: () => void
}

const EMPTY: ReadonlyMap<string, AnchorProxyGroup> = new Map()

export const useAnchorRailStore = create<AnchorRailState>((set) => ({
  focusId: null,
  groups: EMPTY,
  publish: (groups, focusId) => set({ groups, focusId }),
  clear: () => set({ groups: EMPTY, focusId: null }),
}))
