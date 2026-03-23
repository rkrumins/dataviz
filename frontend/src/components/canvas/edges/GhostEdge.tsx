import { memo } from 'react'
import {
    BaseEdge,
    getBezierPath,
    type EdgeProps,
    type Edge,
} from '@xyflow/react'

export interface GhostEdgeData {
    animated?: boolean
    isTraced?: boolean
    [key: string]: unknown
}

export type GhostEdgeProps = EdgeProps<Edge<GhostEdgeData>>

/**
 * GhostEdge - Visual aesthetic for edges targeting unloaded/paginated sub-graphs.
 * Lower opacity, dashed, and uses a gentle fade gradient to imply the target is abstracted.
 */
export const GhostEdge = memo(function GhostEdge({
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
}: GhostEdgeProps) {
    const animated = data?.animated !== false
    const isTraced = data?.isTraced ?? false

    const [edgePath] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        curvature: 0.35,
    })

    const edgeColor = '#9ca3af' // Cool Gray
    const traceColor = '#c084fc'
    const activeColor = isTraced ? traceColor : edgeColor

    return (
        <>
            <defs>
                <linearGradient id={`ghost-grad-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={activeColor} stopOpacity={0.6} />
                    <stop offset="100%" stopColor={activeColor} stopOpacity={0.1} />
                </linearGradient>
            </defs>

            {/* Hover capture */}
            <path
                d={edgePath}
                fill="none"
                stroke="transparent"
                strokeWidth={15}
                className="cursor-pointer"
            />

            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    stroke: `url(#ghost-grad-${id})`,
                    strokeWidth: selected ? 2 : 1.25,
                    strokeDasharray: '4 5',
                    strokeLinecap: 'round',
                    opacity: 0.5,
                    filter: selected ? `drop-shadow(0 0 2px ${activeColor}40)` : undefined,
                    transition: 'stroke-width 0.2s, filter 0.2s',
                }}
            />

            {/* Gentle slow crawl for ghost animations */}
            {animated && (
                <path
                    d={edgePath}
                    fill="none"
                    stroke={activeColor}
                    strokeWidth={1}
                    className="animate-[flow_4s_linear_infinite]"
                    strokeDasharray="2 12"
                    style={{ opacity: 0.5, pointerEvents: 'none' }}
                />
            )}
        </>
    )
})
