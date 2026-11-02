/**
 * NodeConnectionHandle — the hover-reveal affordance on a node card's right edge
 * that starts a connection. Drag it to a target, or just click it: a press that
 * barely moves arms the connection, and the next click on a card picks the
 * target (useEdgeConnect). pointerdown stops propagation so it never triggers
 * the card's HTML5 drag (layer assignment) or selection. Shown only in
 * authoring (draft) mode.
 */
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export interface NodeConnectionHandleProps {
  visible: boolean
  /** Begin a connection drag from this node at the given viewport point. */
  onBeginConnect: (start: { x: number; y: number }) => void
}

export function NodeConnectionHandle({ visible, onBeginConnect }: NodeConnectionHandleProps) {
  return (
    <button
      type="button"
      aria-label="Connect — click, then click the target (or drag to it)"
      title="Click, then click the target — or drag to it"
      // pointerdown (not click) so the drag starts immediately; stop propagation
      // + prevent default so the card's dragstart/selection never fire.
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onBeginConnect({ x: e.clientX, y: e.clientY })
      }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
      className={cn(
        'absolute -right-2.5 top-1/2 -translate-y-1/2 z-20 w-5 h-5 rounded-full',
        'flex items-center justify-center cursor-crosshair',
        'bg-accent-lineage text-white shadow-md ring-2 ring-canvas-elevated',
        'transition-opacity duration-150',
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    >
      <LucideIcons.Plus className="w-3 h-3" />
    </button>
  )
}

export default NodeConnectionHandle
