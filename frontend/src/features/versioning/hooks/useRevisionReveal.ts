/**
 * useRevisionReveal — once a revision opened to show an entity (`OpenRevision.reveal`) has drawn,
 * reveal it with the canvas's own reveal (which expands and loads what it sits in), then select it
 * with its details open: "Open just before it was deleted" lands on the entity as it was then.
 *
 * Mount once per canvas. It waits for the canvas to read the revision and finish drawing it: either
 * it saw that drawing happen, or the entity is already on the canvas, live. Published as it is now
 * never has it (it was deleted there), so a revision not yet drawn never reveals early. One shot.
 */
import { useEffect, useRef } from 'react'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { isGhostNode } from '../canvas/deletionGhosts'

export function useRevisionReveal(reveal: (id: string) => unknown) {
  const revision = useBranchStore((s) => s.revision)
  const readAt = useViewExecutionContext()?.asOfSeq ?? null
  const phase = useCanvasStore((s) => s.hydrationPhase)
  const target = revision?.reveal ?? null
  const reading = !!target && readAt === revision?.seq
  const drawn = useCanvasStore((s) => !!target && s.nodes.some((n) => n.id === target && !isGhostNode(n)))
  const sawDrawing = useRef(false)

  useEffect(() => {
    if (!reading || !target) { sawDrawing.current = false; return }
    if (phase !== 'complete') { sawDrawing.current = true; return }
    if (!sawDrawing.current && !drawn) return
    sawDrawing.current = false
    useBranchStore.setState((s) => (s.revision ? { revision: { ...s.revision, reveal: null } } : {}))
    void Promise.resolve(reveal(target)).then(() => {
      const canvas = useCanvasStore.getState()
      if (!canvas.nodes.some((n) => n.id === target)) return
      canvas.selectNode(target)
      canvas.openNodeDrawer(target)
    })
  }, [reading, target, phase, drawn, reveal])
}
