/**
 * The drawer's back/forward trail — shared by the entity and relationship
 * drawers, because one walk crosses both: a node, the relationship to its
 * consumer, the consumer. Following lineage is a WALK, and a walk you cannot
 * retrace is one people stop taking. Rendered only once there is somewhere to
 * go, so a drawer opened on one thing carries no dead controls.
 *
 * A step is one drawer move (`requestDrawerMove`): with unsaved edits in the
 * drawer it is held, whole, until the reader decides — a step onto the other
 * kind would otherwise unmount the drawer, and its edits, without asking.
 */
import { useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { IconButton } from '@/components/ui/Button'

interface DrawerTrailNavProps {
  /** Reveal a node the trail lands on (best-effort; never blocks the swap). */
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
}

export function DrawerTrailNav({ onFocusNode }: DrawerTrailNavProps) {
  const canBack = useCanvasStore((s) => s.drawerHistory.cursor > 0)
  const canForward = useCanvasStore((s) => s.drawerHistory.cursor < s.drawerHistory.entries.length - 1)

  // Retracing is a move on the CANVAS too: the drawer showing something the
  // board is not looking at is how people lose their place. Select what the
  // trail landed on, so the canvas highlight follows it.
  const step = useCallback((direction: 'back' | 'forward') => {
    useCanvasStore.getState().requestDrawerMove(() => {
      const before = useCanvasStore.getState()
      if (direction === 'back') before.drawerBack()
      else before.drawerForward()
      const s = useCanvasStore.getState()
      if (s.drawerNodeId) {
        s.selectNode(s.drawerNodeId)
        void onFocusNode?.(s.drawerNodeId)
      } else if (s.drawerEdge) {
        const line = s.drawerEdge.kind === 'connection' ? s.drawerEdge.id : s.drawerEdge.lineId
        if (line) s.selectEdge(line)
        else s.clearSelection()
      }
    })
  }, [onFocusNode])

  if (!canBack && !canForward) return null
  return (
    <div className="flex items-center gap-0.5 mr-0.5">
      <IconButton icon={ChevronLeft} label="Back to the previous entity" size="sm"
        disabled={!canBack} onClick={() => step('back')} />
      <IconButton icon={ChevronRight} label="Forward to the next entity" size="sm"
        disabled={!canForward} onClick={() => step('forward')} />
    </div>
  )
}
