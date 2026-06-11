/**
 * ConnectionDragLayer — the rubber-band edge shown while a connection is being
 * dragged. Mounted as an absolute sibling of LineageFlowOverlay inside the same
 * scroll container, so it shares the overlay's coordinate space: anchors are
 * `getBoundingClientRect()` minus this layer's own container rect (matching how
 * LineageFlowOverlay computes its paths). Pointer-events are off so it never
 * intercepts the drop.
 */
import { useRef } from 'react'

export interface ConnectionDragLayerProps {
  /** Source node id (== layer-node-<id>); null when not dragging. */
  sourceId: string | null
  /** Live pointer in viewport coordinates; null when not dragging. */
  pointer: { x: number; y: number } | null
}

export function ConnectionDragLayer({ sourceId, pointer }: ConnectionDragLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  let path: string | null = null
  let head: { x: number; y: number } | null = null
  if (sourceId && pointer && containerRef.current) {
    const sourceEl = document.getElementById(`layer-node-${sourceId}`)
    if (sourceEl) {
      const c = containerRef.current.getBoundingClientRect()
      const s = sourceEl.getBoundingClientRect()
      const sx = s.right - c.left + 6
      const sy = s.top + s.height / 2 - c.top
      const px = pointer.x - c.left
      const py = pointer.y - c.top
      const dx = Math.max(40, Math.abs(px - sx) * 0.4)
      path = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${px - dx} ${py}, ${px} ${py}`
      head = { x: px, y: py }
    }
  }

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[6]">
      <svg className="w-full h-full overflow-visible">
        {path && (
          <>
            <path d={path} fill="none" stroke="var(--accent-lineage, #6366f1)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" className="animate-pulse" />
            {head && <circle cx={head.x} cy={head.y} r={4} fill="var(--accent-lineage, #6366f1)" />}
          </>
        )}
      </svg>
    </div>
  )
}

export default ConnectionDragLayer
