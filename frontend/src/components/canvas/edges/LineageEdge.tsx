import { memo, useMemo } from 'react'
import { 
  BaseEdge, 
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { cn } from '@/lib/utils'

interface LineageEdgeData {
  confidence?: number
  edgeType?: 'produces' | 'consumes' | 'transforms'
  animated?: boolean
  label?: string
}

type LineageEdgeProps = EdgeProps<Edge<LineageEdgeData>>

/**
 * LineageEdge - Custom animated edge with confidence gradients
 * Features:
 * - Animated particle flow showing data direction
 * - Color gradient based on confidence score
 * - Hover state with label tooltip
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

  // Determine edge color based on confidence
  const edgeColor = useMemo(() => {
    if (confidence >= 0.8) return '#6366f1' // High - Indigo
    if (confidence >= 0.5) return '#f59e0b' // Medium - Amber
    return '#ef4444' // Low - Red
  }, [confidence])

  // Gradient ID for this edge
  const gradientId = `edge-gradient-${id}`

  // Edge type icon mapping
  const edgeTypeLabel = {
    produces: '→',
    consumes: '←',
    transforms: '⟷',
  }

  return (
    <>
      {/* Gradient Definition */}
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={edgeColor} stopOpacity={0.4} />
          <stop offset="50%" stopColor={edgeColor} stopOpacity={1} />
          <stop offset="100%" stopColor={edgeColor} stopOpacity={0.4} />
        </linearGradient>
        
        {/* Animated dash pattern for particle effect */}
        <pattern
          id={`flow-pattern-${id}`}
          patternUnits="userSpaceOnUse"
          width="12"
          height="4"
        >
          <circle cx="2" cy="2" r="1.5" fill={edgeColor} opacity="0.8">
            <animate
              attributeName="cx"
              from="-2"
              to="14"
              dur="1s"
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

      {/* Main edge path */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: `url(#${gradientId})`,
          strokeWidth: selected ? 3 : 2,
          filter: selected ? `drop-shadow(0 0 6px ${edgeColor})` : undefined,
          transition: 'stroke-width 0.15s, filter 0.15s',
        }}
      />

      {/* Animated particle overlay */}
      {animated && (
        <path
          d={edgePath}
          fill="none"
          stroke={edgeColor}
          strokeWidth={2}
          strokeDasharray="4 8"
          className="nx-edge-animated"
          style={{
            opacity: 0.6,
          }}
        />
      )}

      {/* Edge label (shown on hover/select) */}
      <EdgeLabelRenderer>
        <div
          className={cn(
            "absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none",
            "transition-opacity duration-150",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
          style={{
            left: labelX,
            top: labelY,
          }}
        >
          <div className={cn(
            "glass-panel-subtle rounded-md px-2 py-1",
            "text-2xs font-medium",
            "flex items-center gap-1.5"
          )}>
            <span className="text-ink-muted">{edgeTypeLabel[edgeType]}</span>
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

