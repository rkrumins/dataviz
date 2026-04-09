import { memo, useMemo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { cn } from '@/lib/utils'
import { useEdgeFiltersStore } from '@/hooks/useEdgeFilters'
import { useEdgeVisual } from '@/hooks/useEntityVisual'

interface LineageEdgeData {
  confidence?: number
  edgeType?: string
  animated?: boolean
  label?: string
  // Trace flags for consistent highlighting
  isTraced?: boolean
  isDimmed?: boolean
  [key: string]: unknown
}

export type LineageEdgeProps = EdgeProps<Edge<LineageEdgeData>>

/**
 * LineageEdge - Custom animated edge with confidence gradients
 * Features:
 * - Animated particle flow showing data direction
 * - Color gradient based on confidence score
 * - Hover state with label tooltip
 * - Highlighting support (glow, pulse, bold)
 */
export const LineageEdge = memo(function LineageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: LineageEdgeProps) {
  const confidence = data?.confidence ?? 1
  const animated = data?.animated !== false
  const edgeType = data?.edgeType || 'produces'
  const isTraced = data?.isTraced ?? false
  const isDimmed = data?.isDimmed ?? false

  // Get highlighting state from store
  const highlightedEdgeIds = useEdgeFiltersStore((s) => s.highlightedEdgeIds)
  const highlightMode = useEdgeFiltersStore((s) => s.highlightMode)
  const isHighlighted = highlightedEdgeIds.has(id) || isTraced

  // Schema-driven edge visual
  const edgeVisual = useEdgeVisual(edgeType)

  // Calculate bezier path
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.25,
  })

  // Determine edge color: schema-driven first, then confidence-based fallback
  const edgeColor = useMemo(() => {
    // Use schema-driven color (includes hash-based palette fallback for unknown types)
    if (edgeType) {
      return edgeVisual.strokeColor
    }

    // Fallback to confidence-based colors when no edge type is set
    if (confidence >= 0.8) return '#6366f1' // High - Indigo
    if (confidence >= 0.5) return '#f59e0b' // Medium - Amber
    return '#ef4444' // Low - Red
  }, [confidence, edgeType, edgeVisual.strokeColor])

  // Highlight color
  const highlightColor = '#f59e0b' // Amber for highlights

  // Gradient ID for this edge
  const gradientId = `edge-gradient-${id}`
  const highlightGradientId = `edge-highlight-gradient-${id}`

  // Format edge type ID to a readable label
  const edgeTypeLabel = edgeType
    .toLowerCase()
    .split('_')
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  // Calculate style based on highlight mode
  const getHighlightStyles = () => {
    if (!isHighlighted) return {}

    switch (highlightMode) {
      case 'glow':
        return {
          filter: `drop-shadow(0 0 3px ${highlightColor}60)`,
        }
      case 'bold':
        return {
          strokeWidth: 2.5,
        }
      case 'pulse':
        return {
          animation: 'pulse 1.5s ease-in-out infinite',
        }
      default:
        return {}
    }
  }

  const highlightStyles = getHighlightStyles()

  return (
    <>
      {/* Style for pulse animation */}
      {isHighlighted && highlightMode === 'pulse' && (
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; stroke-width: 2; }
            50% { opacity: 0.5; stroke-width: 3; }
          }
        `}</style>
      )}

      {/* Gradient Definitions */}
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={edgeColor} stopOpacity={0.4} />
          <stop offset="50%" stopColor={edgeColor} stopOpacity={1} />
          <stop offset="100%" stopColor={edgeColor} stopOpacity={0.4} />
        </linearGradient>

        {/* Highlight gradient */}
        {isHighlighted && (
          <linearGradient id={highlightGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={highlightColor} stopOpacity={0.6} />
            <stop offset="50%" stopColor={highlightColor} stopOpacity={1} />
            <stop offset="100%" stopColor={highlightColor} stopOpacity={0.6} />
          </linearGradient>
        )}

        {/* Animated flow pattern for particle effect - higher performance svg-native flow */}
        <pattern
          id={`flow-pattern-${id}`}
          patternUnits="userSpaceOnUse"
          width="40"
          height="10"
          patternTransform="rotate(0)"
        >
          <circle cx="5" cy="5" r="2" fill={isHighlighted ? highlightColor : edgeColor}>
            <animate
              attributeName="cx"
              from="0"
              to="40"
              dur="1.5s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0;1;0"
              dur="1.5s"
              repeatCount="indefinite"
            />
          </circle>
        </pattern>
      </defs>

      {/* Background edge (wider, for hover area) */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="cursor-pointer"
      />

      {/* Highlight glow layer — subtle */}
      {isHighlighted && highlightMode === 'glow' && (
        <path
          d={edgePath}
          fill="none"
          stroke={highlightColor}
          strokeWidth={4}
          strokeOpacity={0.15}
          style={{
            filter: 'blur(2px)',
          }}
        />
      )}

      {/* Trace glow layer — subtle */}
      {isTraced && !isDimmed && (
        <path
          d={edgePath}
          fill="none"
          stroke="#c084fc"
          strokeWidth={4}
          strokeOpacity={0.12}
          style={{
            filter: 'blur(2px)',
          }}
        />
      )}

      {/* Main edge path */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isDimmed
            ? '#9ca3af'
            : isTraced
              ? '#c084fc'
              : isHighlighted
                ? `url(#${highlightGradientId})`
                : `url(#${gradientId})`,
          strokeWidth: isDimmed ? 0.75 : selected ? 2 : isTraced ? 2 : (isHighlighted && highlightMode === 'bold' ? 2.5 : 1.5),
          strokeOpacity: isDimmed ? 0.15 : 0.85,
          filter: isDimmed
            ? 'grayscale(1)'
            : isTraced
              ? 'drop-shadow(0 0 2px #c084fc40)'
              : selected
                ? `drop-shadow(0 0 3px ${edgeColor}40)`
                : undefined,
          transition: 'stroke-width 0.15s, filter 0.15s, stroke-opacity 0.15s',
          ...highlightStyles,
        }}
      />

      {/* Animated Flow Layer — only on interaction */}
      {animated && !isDimmed && (selected || isHighlighted || isTraced) && (
        <path
          d={edgePath}
          fill="none"
          stroke={`url(#flow-pattern-${id})`}
          strokeWidth={isTraced ? 2.5 : 2}
          strokeOpacity={0.5}
          style={{
            pointerEvents: 'none',
          }}
        />
      )}


      {/* Highlight indicator icon */}
      {isHighlighted && (
        <EdgeLabelRenderer>
          <div
            className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              left: sourceX + (targetX - sourceX) * 0.15,
              top: sourceY + (targetY - sourceY) * 0.15,
            }}
          >
            <div className="w-3 h-3 rounded-full bg-amber-500/80 flex items-center justify-center animate-pulse">
              <span className="text-white text-[7px]">★</span>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}

      {/* Edge label (shown on hover/select or when highlighted) */}
      <EdgeLabelRenderer>
        <div
          className={cn(
            "absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none",
            "transition-opacity duration-150",
            (selected || isHighlighted) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
          style={{
            left: labelX,
            top: labelY,
          }}
        >
          <div className={cn(
            "glass-panel-subtle rounded-md px-2 py-1",
            "text-2xs font-medium",
            "flex items-center gap-1.5",
            isHighlighted && "ring-1 ring-amber-500/50"
          )}>
            <span className="text-ink-muted">{edgeTypeLabel}</span>
            <span className={cn(
              confidence >= 0.8 ? "text-indigo-500" :
                confidence >= 0.5 ? "text-amber-500" : "text-red-500"
            )}>
              {Math.round(confidence * 100)}%
            </span>
            {data?.label && (
              <>
                <span className="text-ink-muted">•</span>
                <span className="text-ink-secondary">{data.label}</span>
              </>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  )
})


