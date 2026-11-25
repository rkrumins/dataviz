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
import { pickLineMotion, type LineMotion } from './lineMotion'

/** A held line's colour over its still line. A moving line's dashes cover about a
 *  third of it at 0.95; solid, this much lays down the same colour. */
const HELD_OPACITY = 0.4

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
  const { moving, held } = useMemo(
    () => pickLineMotion(lines, mode, { hoveredEdgeId, hoveredNodeId, highlighted }),
    [lines, mode, hoveredEdgeId, hoveredNodeId, highlighted],
  )
  if (moving.length === 0 && held.length === 0) return null
  // A ghost or a roll-up is a summary line, drawn quieter: a halo under its
  // chevrons would only lift it back up.
  const haloed = moving.filter(line => !line.isGhost && !line.isAggregated)
  return (
    <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" aria-hidden>
      {/* Held still (the calm mode's crowd): the colour a moving line lays over
          its still line, without the march — a dense trace keeps its strength. */}
      {held.map(line => (
        <path
          key={line.id}
          data-held-line={line.id}
          d={line.pathD}
          style={{
            stroke: line.color,
            strokeWidth: Math.max(2, line.dynamicStrokeWidth * 1.05),
            fill: 'none',
            strokeOpacity: HELD_OPACITY * (line.isGhost ? 0.7 : 1),
            strokeLinecap: 'round',
          }}
        />
      ))}
      {/* The halo under the chevrons — contrast against the ground: a dark
          tint on the light theme, white on the dark. ONE group with ONE
          opacity: the group composites once, so where a trace's fan of lines
          converges the halos merge instead of stacking — each at its own
          opacity, sixty of them summed to a white haze over the lines. */}
      {haloed.length > 0 && (
        <g className="stroke-slate-900 opacity-[0.07] dark:stroke-white dark:opacity-[0.12]">
          {haloed.map(line => (
            <path
              key={line.id}
              d={line.pathD}
              className="edge-direction-flow"
              style={{
                strokeWidth: Math.max(2.5, line.dynamicStrokeWidth * 1.2),
                fill: 'none',
                strokeLinecap: 'round',
                strokeDasharray: '10 18',
                strokeDashoffset: 4,
              }}
            />
          ))}
        </g>
      )}
      {moving.map(line => (
        <path
          key={line.id}
          data-moving-line={line.id}
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
      ))}
    </svg>
  )
}
