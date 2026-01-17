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

interface LineageEdgeData {
  confidence?: number
  edgeType?: 'produces' | 'consumes' | 'transforms'
  animated?: boolean
  label?: string
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

  // Get highlighting state from store
  const highlightedEdgeIds = useEdgeFiltersStore((s) => s.highlightedEdgeIds)
  const highlightMode = useEdgeFiltersStore((s) => s.highlightMode)
  const isHighlighted = highlightedEdgeIds.has(id)

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

  // Determine edge color based on confidence or edge type
  const edgeColor = useMemo(() => {
    // Color by type
    const typeColors: Record<string, string> = {
      produces: '#22c55e',
      consumes: '#3b82f6',
      transforms: '#f59e0b',
      contains: '#8b5cf6',
      lineage: '#6366f1',
    }

    if (edgeType && typeColors[edgeType]) {
      return typeColors[edgeType]
    }

    // Fallback to confidence-based colors
    if (confidence >= 0.8) return '#6366f1' // High - Indigo
    if (confidence >= 0.5) return '#f59e0b' // Medium - Amber
    return '#ef4444' // Low - Red
  }, [confidence, edgeType])

  // Highlight color
  const highlightColor = '#f59e0b' // Amber for highlights

  // Gradient ID for this edge
  const gradientId = `edge-gradient-${id}`
  const highlightGradientId = `edge-highlight-gradient-${id}`

  // Edge type icon mapping
  const edgeTypeLabel: Record<string, string> = {
    produces: '→',
    consumes: '←',
    transforms: '⟷',
    contains: '⊂',
    lineage: '→',
  }

  // Calculate style based on highlight mode
  const getHighlightStyles = () => {
    if (!isHighlighted) return {}

    switch (highlightMode) {
      case 'glow':
        return {
          filter: `drop-shadow(0 0 8px ${highlightColor}) drop-shadow(0 0 12px ${highlightColor})`,
        }
      case 'bold':
        return {
          strokeWidth: 4,
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
            0%, 100% { opacity: 1; stroke-width: 3; }
            50% { opacity: 0.6; stroke-width: 5; }
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

        {/* Animated dash pattern for particle effect */}
        <pattern
          id={`flow-pattern-${id}`}
          patternUnits="userSpaceOnUse"
          width="12"
          height="4"
        >
          <circle cx="2" cy="2" r="1.5" fill={isHighlighted ? highlightColor : edgeColor} opacity="0.8">
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

      {/* Highlight glow layer (behind main edge) */}
      {isHighlighted && highlightMode === 'glow' && (
        <path
          d={edgePath}
          fill="none"
          stroke={highlightColor}
          strokeWidth={8}
          strokeOpacity={0.3}
          style={{
            filter: `blur(4px)`,
          }}
        />
      )}

      {/* Main edge path */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: isHighlighted ? `url(#${highlightGradientId})` : `url(#${gradientId})`,
          strokeWidth: selected ? 3 : (isHighlighted && highlightMode === 'bold' ? 4 : 2),
          filter: selected ? `drop-shadow(0 0 6px ${edgeColor})` : undefined,
          transition: 'stroke-width 0.15s, filter 0.15s',
          ...highlightStyles,
        }}
      />

      {/* Animated particle overlay */}
      {animated && (
        <path
          d={edgePath}
          fill="none"
          stroke={isHighlighted ? highlightColor : edgeColor}
          strokeWidth={2}
          strokeDasharray="4 8"
          className="nx-edge-animated"
          style={{
            opacity: isHighlighted ? 0.8 : 0.6,
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
            <div className="w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center animate-pulse">
              <span className="text-white text-2xs">★</span>
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
            <span className="text-ink-muted">{edgeTypeLabel[edgeType] || '→'}</span>
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


