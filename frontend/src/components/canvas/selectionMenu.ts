/**
 * The selection, from a right-click — shared by every canvas's context menu.
 *
 * A right-click on an entity that is part of a selection of several acts on the selection; on any
 * other entity, on that entity alone. "Compare & edit N…" opens the entity drawer on the several
 * at once (`MultiEntityDrawer`): where they differ, and one change for all in a draft.
 */
import { isSelectableNode, useCanvasStore } from '@/store/canvas'
import type { ContextMenuAction } from './CanvasContextMenu'

/** What a right-click on `targetId` acts on: the selection it is part of, or itself. */
export function menuSelection(targetId: string, selectedNodeIds: readonly string[]): string[] {
  const selection = selectedNodeIds.filter(isSelectableNode)
  return selection.length > 1 && selection.includes(targetId) ? selection : [targetId]
}

/** "Compare & edit N…" — the entity drawer on `ids`, together. */
export function compareSelectionAction(ids: readonly string[], closeMenu: () => void): ContextMenuAction {
  return {
    id: 'compare-selection',
    label: `Compare & edit ${ids.length.toLocaleString()}…`,
    icon: 'Layers',
    onClick: () => { closeMenu(); useCanvasStore.getState().openNodesDrawer(ids) },
  }
}
