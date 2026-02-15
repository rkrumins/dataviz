/**
 * AggregatedEdge - Edge component for aggregated/inferred lineage
 * 
 * Shows lineage that was aggregated from column-level to table-level.
 * Displays confidence and source edge count on hover.
 */

import { useState, memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AggregatedEdgeData {
  confidence?: number
  sourceEdgeCount?: number
  sourceEdges?: string[]
  edgeType?: string
  isAggregated?: boolean
  // Trace flags for consistent highlighting
  isTraced?: boolean
  isDimmed?: boolean
  [key: string]: unknown
}

export const AggregatedEdge = memo(function AggregatedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  style = {},
}: EdgeProps<Edge<AggregatedEdgeData>>) {
  const [isHovered, setIsHovered] = useState(false)

  const confidence = data?.confidence ?? 0.5
  const sourceCount = data?.sourceEdgeCount ?? 1
  const isTraced = data?.isTraced ?? false
  const isDimmed = data?.isDimmed ?? false

  // Calculate path
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  // Color based on confidence
  const getConfidenceColor = (conf: number) => {
    if (conf >= 0.8) return '#22c55e' // Green - high confidence
    if (conf >= 0.5) return '#f59e0b' // Amber - medium confidence
    return '#ef4444' // Red - low confidence
  }

  const edgeColor = getConfidenceColor(confidence)

  // Trace color - purple for traced aggregated edges
  const traceColor = '#c084fc'

  return (
    <>
      {/* Trace Glow Layer */}
      {isTraced && !isDimmed && (
        <path
          d={edgePath}
          fill="none"
          stroke={traceColor}
          strokeWidth={12}
          strokeOpacity={0.25}
          style={{
            filter: 'blur(4px)',
          }}
        />
      )}

      {/* Edge Path */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...(style as React.CSSProperties),
          stroke: isDimmed ? '#9ca3af' : isTraced ? traceColor : edgeColor,
          strokeWidth: isDimmed ? 1 : isTraced ? 3 : selected ? 3 : 2,
          strokeDasharray: '8 4',
          opacity: isDimmed ? 0.2 : isHovered ? 1 : 0.7,
          filter: isTraced && !isDimmed ? `drop-shadow(0 0 6px ${traceColor})` : undefined,
        }}
        interactionWidth={20}
        className="transition-all duration-200"
      />

      {/* Animated Flow Particles */}
      {!isDimmed && (
        <path
          d={edgePath}
          fill="none"
          stroke={isTraced ? traceColor : edgeColor}
          strokeWidth={isTraced ? 3 : 2}
          strokeDasharray="1 10"
          className="animate-[flow_2s_linear_infinite]"
          style={{
            opacity: 0.8,
            strokeLinecap: 'round',
          }}
        />
      )}

      {/* Hover/Interactive Area */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="cursor-pointer"
      />

      {/* Edge Label */}
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Badge */}
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-full",
              "text-2xs font-medium transition-all duration-200",
              "cursor-pointer",
              isDimmed && "opacity-20 grayscale",
              isTraced && !isDimmed
                ? "bg-purple-500 text-white shadow-lg ring-2 ring-purple-300"
                : selected || isHovered
                  ? "bg-amber-500 text-white shadow-lg scale-110"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            )}
          >
            <Layers className="w-3 h-3" />
            <span>{sourceCount}</span>
          </div>

          {/* Tooltip on Hover */}
          <AnimatePresence>
            {isHovered && (
              <motion.div
                initial={{ opacity: 0, y: 4, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.95 }}
                className={cn(
                  "absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50",
                  "glass-panel rounded-lg px-3 py-2 min-w-[180px]",
                  "text-xs shadow-lg"
                )}
              >
                <div className="font-semibold text-ink mb-2 flex items-center gap-2">
                  <ArrowRight className="w-3 h-3 text-amber-500" />
                  Aggregated Lineage
                </div>

                <div className="space-y-1.5 text-ink-secondary">
                  <div className="flex justify-between">
                    <span>Source Edges:</span>
                    <span className="font-medium text-ink">{sourceCount}</span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span>Confidence:</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-12 h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${confidence * 100}%`,
                            backgroundColor: edgeColor,
                          }}
                        />
                      </div>
                      <span className="font-medium text-ink w-8 text-right">
                        {Math.round(confidence * 100)}%
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-glass-border text-2xs text-ink-muted">
                  Click to see column-level details
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </EdgeLabelRenderer>
    </>
  )
})

