/**
 * ConnectionDragLayer — the rubber-band edge shown while a connection is being
 * dragged. Mounted as an absolute sibling of LineageFlowOverlay inside the same
 * scroll container, so it shares the overlay's coordinate space: anchors are
 * `getBoundingClientRect()` minus this layer's own container rect (matching how
 * LineageFlowOverlay computes its paths). Pointer-events are off so it never
 * intercepts the drop.
 *
 * A drag that carries a selection draws a band from every selected card that
 * is on screen, gathering at the cursor, with how many are being carried and —
 * over a card — what dropping there would do.
 */
import { useRef } from 'react'
import { cn } from '@/lib/utils'

/** Bands drawn at most; the count badge carries the rest. */
const MAX_BANDS = 24

export interface ConnectionDragLayerProps {
  /** The cards being dragged (layer-node-<id>); empty when not dragging. */
  sourceIds: readonly string[]
  /** Live pointer in viewport coordinates; null when not dragging. */
  pointer: { x: number; y: number } | null
  /** What dropping on the hovered card would do; null when over no card. */
  hint?: { level: 'all' | 'some' | 'none'; text: string } | null
}

export function ConnectionDragLayer({ sourceIds, pointer, hint = null }: ConnectionDragLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const paths: string[] = []
  let head: { x: number; y: number } | null = null
  if (sourceIds.length > 0 && pointer && containerRef.current) {
    const c = containerRef.current.getBoundingClientRect()
    const px = pointer.x - c.left
    const py = pointer.y - c.top
    head = { x: px, y: py }
    for (const id of sourceIds) {
      if (paths.length >= MAX_BANDS) break
      const sourceEl = document.getElementById(`layer-node-${id}`)
      if (!sourceEl) continue
      const s = sourceEl.getBoundingClientRect()
      const sx = s.right - c.left + 6
      const sy = s.top + s.height / 2 - c.top
      const dx = Math.max(40, Math.abs(px - sx) * 0.4)
      paths.push(`M ${sx} ${sy} C ${sx + dx} ${sy}, ${px - dx} ${py}, ${px} ${py}`)
    }
  }

  const bulk = sourceIds.length > 1
  const tone = hint?.level === 'all'
    ? 'rgb(var(--nx-lineage-out-rgb))'
    : hint?.level === 'some'
      ? '#f59e0b'
      : hint?.level === 'none'
        ? '#ef4444'
        : 'rgb(var(--nx-accent-lineage-rgb))'

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[6]">
      <svg className="w-full h-full overflow-visible">
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={tone}
            strokeWidth={bulk ? 1.6 : 2}
            strokeOpacity={bulk ? 0.8 : 1}
            strokeDasharray="6 4"
            strokeLinecap="round"
            className="animate-pulse motion-reduce:animate-none"
          />
        ))}
        {head && <circle cx={head.x} cy={head.y} r={4} fill={tone} />}
      </svg>
      {head && (bulk || hint) && (
        <div
          className="absolute flex items-center gap-1.5"
          style={{ left: head.x + 12, top: head.y + 10 }}
        >
          {bulk && (
            <span className="min-w-[22px] h-[22px] px-1.5 rounded-full grid place-items-center bg-accent-lineage text-white text-[11px] font-semibold tabular-nums shadow-md ring-2 ring-canvas-elevated">
              {sourceIds.length.toLocaleString()}
            </span>
          )}
          {hint && (
            <span
              className={cn(
                'max-w-[280px] truncate px-2 py-1 rounded-lg bg-canvas-elevated border shadow-md text-[11.5px] font-medium',
                hint.level === 'all' && 'border-lineage-out/40 text-ink',
                hint.level === 'some' && 'border-amber-500/40 text-ink',
                hint.level === 'none' && 'border-red-500/40 text-red-600 dark:text-red-400',
              )}
            >
              {hint.text}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default ConnectionDragLayer
