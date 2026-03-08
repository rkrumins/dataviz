import { memo, useState, useMemo } from 'react'
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

export interface BundledEdgeData {
    confidence?: number
    edgeCount?: number
    edgeTypes?: string[]
    isAggregated?: boolean
    isGhost?: boolean
    sourceEdgeIds?: string[]
    animated?: boolean
    isTraced?: boolean
    isDimmed?: boolean
    [key: string]: unknown
}

export type BundledEdgeProps = EdgeProps<Edge<BundledEdgeData>>

/**
 * BundledEdge - Custom edge for semantic edge bundling.
 * Compresses multiple distinct edges into a single thick, elegant Bezier path.
 * Stroke width scales logarithmically with volume.
 */
export const BundledEdge = memo(function BundledEdge({
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
}: BundledEdgeProps) {
    const [isHovered, setIsHovered] = useState(false)

    const confidence = data?.confidence ?? 1
    const animated = data?.animated !== false
    const edgeCount = Math.max(1, data?.edgeCount ?? 1)
    const edgeTypes = data?.edgeTypes || []
    const isTraced = data?.isTraced ?? false
    const isDimmed = data?.isDimmed ?? false

    // Base stroke width scales gracefully with edge block length
    const strokeWidth = Math.min(2 + Math.log2(edgeCount) * 1.5, 12)

    // Calculate sleek Bezier path
    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        curvature: 0.35, // Smooth organic curve
    })

    // Color mapping based on confidence
    const edgeColor = useMemo(() => {
        if (confidence >= 0.8) return '#6366f1' // Indigo
        if (confidence >= 0.5) return '#f59e0b' // Amber
        return '#ef4444' // Red
    }, [confidence])

    const traceColor = '#c084fc'
    const gradientId = `bundle-gradient-${id}`

    return (
        <>
            <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={edgeColor} stopOpacity={0.6} />
                    <stop offset="50%" stopColor={edgeColor} stopOpacity={1} />
                    <stop offset="100%" stopColor={edgeColor} stopOpacity={0.6} />
                </linearGradient>

                <pattern
                    id={`bundle-flow-${id}`}
                    patternUnits="userSpaceOnUse"
                    width="40"
                    height="10"
                >
                    {/* A sleek dashed dasharray moving along the bundled edge */}
                    <line
                        x1="0" y1="5" x2="20" y2="5"
                        stroke={isTraced ? traceColor : '#ffffff'}
                        strokeWidth="2"
                        strokeOpacity="0.4"
                    >
                        <animate attributeName="x1" from="-40" to="0" dur="1s" repeatCount="indefinite" />
                        <animate attributeName="x2" from="-20" to="20" dur="1s" repeatCount="indefinite" />
                    </line>
                </pattern>
            </defs>

            {/* Background interaction area wrapper */}
            <path
                d={edgePath}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(20, strokeWidth + 10)}
                className="cursor-pointer"
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            />

            {/* Trace glow */}
            {isTraced && !isDimmed && (
                <path
                    d={edgePath}
                    fill="none"
                    stroke={traceColor}
                    strokeWidth={strokeWidth + 8}
                    strokeOpacity={0.3}
                    style={{ filter: 'blur(4px)' }}
                />
            )}

            {/* Main sleek path */}
            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    stroke: isDimmed ? '#9ca3af' : isTraced ? traceColor : `url(#${gradientId})`,
                    strokeWidth: isDimmed ? Math.max(1, strokeWidth - 2) : selected ? strokeWidth + 2 : strokeWidth,
                    strokeOpacity: isDimmed ? 0.2 : 0.9,
                    filter: isDimmed
                        ? 'grayscale(1)'
                        : isTraced
                            ? `drop-shadow(0 0 6px ${traceColor})`
                            : selected || isHovered
                                ? `drop-shadow(0 0 8px ${edgeColor})`
                                : undefined,
                    transition: 'stroke-width 0.2s cubic-bezier(0.4, 0, 0.2, 1), filter 0.2s',
                }}
                className={cn("transition-all duration-300", (selected || isHovered) ? "z-50" : "z-0")}
            />

            {/* Animated Flow Overlay */}
            {animated && !isDimmed && (isHovered || selected || isTraced) && (
                <path
                    d={edgePath}
                    fill="none"
                    stroke={`url(#bundle-flow-${id})`}
                    strokeWidth={strokeWidth * 0.5}
                    className="pointer-events-none drop-shadow-sm"
                />
            )}

            {/* Floating Center Badge & Popover */}
            <EdgeLabelRenderer>
                <div
                    className={cn(
                        "absolute transform -translate-x-1/2 -translate-y-1/2",
                        "transition-all duration-200 pointer-events-auto",
                        isDimmed ? "opacity-20 grayscale scale-95" : (isHovered || selected) ? "scale-110 z-50" : "opacity-80 scale-100"
                    )}
                    style={{ left: labelX, top: labelY }}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className={cn(
                        "flex items-center gap-1 px-2 py-0.5 rounded-full border shadow-sm backdrop-blur-md",
                        "text-2xs font-semibold cursor-pointer",
                        isTraced
                            ? "bg-purple-500/90 text-white border-purple-400"
                            : "bg-white/80 dark:bg-canvas-elevated/80 text-ink border-glass-border"
                    )}>
                        <Layers className={cn("w-3 h-3", isTraced ? "text-purple-200" : "text-amber-500")} />
                        <span>{edgeCount}</span>
                    </div>

                    <AnimatePresence>
                        {isHovered && !isDimmed && (
                            <motion.div
                                initial={{ opacity: 0, y: 5, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 5, scale: 0.95 }}
                                className={cn(
                                    "absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50",
                                    "glass-panel rounded-xl px-4 py-3 min-w-[200px]",
                                    "text-xs shadow-2xl border border-glass-border/30 backdrop-blur-xl"
                                )}
                            >
                                <div className="font-bold text-ink mb-1.5 flex items-center gap-2">
                                    <ArrowRight className="w-3.5 h-3.5 text-indigo-500" />
                                    Bundled Link
                                </div>

                                <div className="text-ink-secondary mb-2">
                                    This connection represents <strong className="text-ink">{edgeCount}</strong> distinct data flows bundled to reduce visual clutter.
                                </div>

                                {edgeTypes.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-2">
                                        {edgeTypes.map(et => (
                                            <span key={et} className="px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/5 text-2xs font-medium text-ink-muted">
                                                {et}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </EdgeLabelRenderer>
        </>
    )
})
