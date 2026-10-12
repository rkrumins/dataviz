/**
 * The moving part of the lineage lines — see lineMotion.ts for which move.
 *
 * Its own layer, over the still lines and like them under the cards, so that
 * what the reader hovers can move without the overlay re-rendering a single
 * still line: this is the only component that follows the pointer. The
 * keyframes (`edge-direction-flow`) are the overlay's.
 */
import { useMemo } from 'react'
import { useHoveredNodeId } from '@/hooks/useHighlightState'
import type { ComputedEdge } from './types'
import { pickMovingLines, type LineMotion } from './lineMotion'

export function LineMotionLayer({
  lines,
  mode,
  hoveredEdgeId,
  highlighted,
}: {
  lines: ComputedEdge[]
  mode: LineMotion
  hoveredEdgeId: string | null
  highlighted: ReadonlySet<string> | null
}) {
  const hoveredNodeId = useHoveredNodeId()
  const moving = useMemo(
    () => pickMovingLines(lines, mode, { hoveredEdgeId, hoveredNodeId, highlighted }),
    [lines, mode, hoveredEdgeId, hoveredNodeId, highlighted],
  )
  if (moving.length === 0) return null
  return (
    <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" aria-hidden>
      {moving.map(line => (
        <g key={line.id} data-moving-line={line.id}>
          {/* White underlay — contrast for the coloured chevrons on any ground */}
          <path
            d={line.pathD}
            className="edge-direction-flow"
            style={{
              stroke: 'white',
              strokeWidth: Math.max(2.5, line.dynamicStrokeWidth * 1.2),
              fill: 'none',
              strokeOpacity: line.isGhost ? 0.10 : 0.18,
              strokeLinecap: 'round',
              strokeDasharray: '10 18',
              strokeDashoffset: 4,
            }}
          />
          <path
            d={line.pathD}
            className="edge-direction-flow"
            style={{
              stroke: line.color,
              strokeWidth: Math.max(2, line.dynamicStrokeWidth * 1.05),
              fill: 'none',
              strokeOpacity: line.isGhost ? 0.7 : 0.95,
              strokeLinecap: 'round',
              strokeDasharray: '10 18',
            }}
          />
        </g>
      ))}
    </svg>
  )
}
