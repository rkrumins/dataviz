/**
 * ConnectOverlay — the rubber-band edge shown while drawing a connection, with
 * live ontology-validity feedback. Mounted as an absolute sibling of
 * LineageFlowOverlay inside the same scroll container so it shares the overlay's
 * coordinate space (anchors are getBoundingClientRect minus this container's
 * rect, matching how the lineage overlay computes paths). Pointer-events are off
 * so it never intercepts the drop.
 *
 * The band turns valid (accent) / invalid (danger) as the hovered target's type
 * enters/leaves the source's set of legal target types — the per-card dim/ring
 * is applied in FlatTreeItem from the same connectContext.
 */
import { useRef } from 'react'

export interface ConnectOverlayProps {
  /** Source node id (== layer-node-<id>); null when not connecting via drag. */
  sourceId: string | null
  /** Live pointer in viewport coordinates; null when not dragging. */
  pointer: { x: number; y: number } | null
  /** Node id currently under the pointer (null when over empty space). */
  hoverTargetId: string | null
  /** Entity type ids the source may legally connect to. */
  validTypeIds: Set<string> | null
  /** Resolve a node id → its entity type, for hover validity. */
  typeOf: (id: string) => string | null
}

export function ConnectOverlay({ sourceId, pointer, hoverTargetId, validTypeIds, typeOf }: ConnectOverlayProps) {
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

  // Validity of the current hover: neutral when over empty space, valid/invalid
  // when over a node, based on the source's legal target types.
  let stroke = 'var(--accent-lineage, #6366f1)'
  if (hoverTargetId && hoverTargetId !== sourceId) {
    const t = typeOf(hoverTargetId)
    const ok = !validTypeIds || (t != null && validTypeIds.has(t))
    stroke = ok ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'
  }

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[6]">
      <svg className="w-full h-full overflow-visible">
        {path && (
          <>
            <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" className="animate-pulse" />
            {head && <circle cx={head.x} cy={head.y} r={4} fill={stroke} />}
          </>
        )}
      </svg>
    </div>
  )
}

export default ConnectOverlay
