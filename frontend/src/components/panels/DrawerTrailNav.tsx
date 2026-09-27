/**
 * The drawer's back/forward trail — shared by the entity and relationship
 * drawers, because one walk crosses both: a node, the relationship to its
 * consumer, the consumer. Following lineage is a WALK, and a walk you cannot
 * retrace is one people stop taking. Rendered only once there is somewhere to
 * go, so a drawer opened on one thing carries no dead controls.
 */
import { useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { cn } from '@/lib/utils'

interface DrawerTrailNavProps {
  /** Reveal a node the trail lands on (best-effort; never blocks the swap). */
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  /** The owning drawer's unsaved-changes gate: runs the step now, or holds it
   *  until the reader chooses to discard. Without it, a step onto the other
   *  kind would unmount the drawer — and its edits — without asking. */
  guard?: (step: () => void) => void
}

export function DrawerTrailNav({ onFocusNode, guard }: DrawerTrailNavProps) {
  const drawerBack = useCanvasStore((s) => s.drawerBack)
  const drawerForward = useCanvasStore((s) => s.drawerForward)
  const canBack = useCanvasStore((s) => s.drawerHistory.cursor > 0)
  const canForward = useCanvasStore((s) => s.drawerHistory.cursor < s.drawerHistory.entries.length - 1)

  // Retracing is a move on the CANVAS too: the drawer showing something the
  // board is not looking at is how people lose their place. Select what the
  // trail landed on, so the canvas highlight follows it.
  const step = useCallback((move: () => void) => {
    const run = () => {
      move()
      const s = useCanvasStore.getState()
      if (s.drawerNodeId) {
        s.selectNode(s.drawerNodeId)
        void onFocusNode?.(s.drawerNodeId)
      } else if (s.drawerEdge) {
        const line = s.drawerEdge.kind === 'connection' ? s.drawerEdge.id : s.drawerEdge.lineId
        if (line) s.selectEdge(line)
        else s.clearSelection()
      }
    }
    if (guard) guard(run)
    else run()
  }, [guard, onFocusNode])

  if (!canBack && !canForward) return null
  return (
    <div className="flex items-center gap-0.5 mr-0.5">
      <TrailButton
        onClick={() => step(drawerBack)}
        enabled={canBack}
        label="Back to the previous entity"
        title="Back"
      >
        <ChevronLeft className="w-4 h-4" />
      </TrailButton>
      <TrailButton
        onClick={() => step(drawerForward)}
        enabled={canForward}
        label="Forward to the next entity"
        title="Forward"
      >
        <ChevronRight className="w-4 h-4" />
      </TrailButton>
    </div>
  )
}

function TrailButton({ onClick, enabled, label, title, children }: {
  onClick: () => void
  enabled: boolean
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={label}
      title={title}
      className={cn(
        'p-1.5 rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        enabled
          ? 'text-ink-muted hover:text-ink hover:bg-white/10'
          : 'text-ink-muted opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}
