/**
 * EdgeLegend - Displays a legend explaining edge types, colors, and meanings
 * 
 * Features:
 * - List of all edge types currently in view
 * - Click on legend item to highlight all edges of that type
 * - Toggle visibility per edge type
 * - Shows count of edges per type
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    GitBranch,
    ChevronDown,
    ChevronUp,
    Eye,
    EyeOff,
    Sparkles,
    ArrowRight,
    Box,
    Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useEdgeFiltersStore } from '@/hooks/useEdgeFilters'

// Edge type definitions with visual styling
export interface EdgeTypeDefinition {
    type: string
    label: string
    description: string
    color: string
    strokeStyle: 'solid' | 'dashed' | 'dotted'
    animated: boolean
    icon: React.ReactNode
}

export const EDGE_TYPE_DEFINITIONS: EdgeTypeDefinition[] = [
    {
        type: 'produces',
        label: 'Produces',
        description: 'Data flow from source to target',
        color: '#06b6d4', // cyan-500
        strokeStyle: 'solid',
        animated: true,
        icon: <ArrowRight className="w-3.5 h-3.5" />,
    },
    {
        type: 'consumes',
        label: 'Consumes',
        description: 'Target reads data from source',
        color: '#3b82f6', // blue-500
        strokeStyle: 'solid',
        animated: true,
        icon: <ArrowRight className="w-3.5 h-3.5 rotate-180" />,
    },
    {
        type: 'transforms',
        label: 'Transforms',
        description: 'Data transformation/derivation',
        color: '#8b5cf6', // purple-500
        strokeStyle: 'solid',
        animated: true,
        icon: <Sparkles className="w-3.5 h-3.5" />,
    },
    {
        type: 'derives_from',
        label: 'Derives From',
        description: 'Column-level derivation relationship',
        color: '#a855f7', // purple-400
        strokeStyle: 'solid',
        animated: true,
        icon: <GitBranch className="w-3.5 h-3.5" />,
    },
    {
        type: 'contains',
        label: 'Contains',
        description: 'Parent-child containment',
        color: '#94a3b8', // slate-400
        strokeStyle: 'dashed',
        animated: false,
        icon: <Box className="w-3.5 h-3.5" />,
    },
    {
        type: 'aggregated',
        label: 'Aggregated',
        description: 'Roll-up of child-level lineage',
        color: '#f59e0b', // amber-500
        strokeStyle: 'dashed',
        animated: false,
        icon: <Layers className="w-3.5 h-3.5" />,
    },
]

interface EdgeLegendProps {
    className?: string
    defaultExpanded?: boolean
}

export function EdgeLegend({ className, defaultExpanded = false }: EdgeLegendProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded)
    const edges = useCanvasStore((s) => s.edges)

    const {
        highlightedEdgeIds,
        setHighlightedEdges,
        clearHighlightedEdges,
        filters,
        toggleFilter,
    } = useEdgeFiltersStore()

    // Count edges by type
    const edgeCountsByType = edges.reduce((acc, edge) => {
        const edgeType = edge.data?.edgeType ?? edge.data?.relationship ?? 'lineage'
        acc[edgeType] = (acc[edgeType] ?? 0) + 1
        return acc
    }, {} as Record<string, number>)

    // Get unique edge types in current view
    const activeEdgeTypes = EDGE_TYPE_DEFINITIONS.filter(
        (def) => edgeCountsByType[def.type] && edgeCountsByType[def.type] > 0
    )

    // Handle legend item click - highlight all edges of that type
    const handleHighlightType = (type: string) => {
        const edgeIds = edges
            .filter((e) => (e.data?.edgeType ?? e.data?.relationship) === type)
            .map((e) => e.id)

        // Toggle behavior - if already highlighted, clear
        const allHighlighted = edgeIds.every((id) => highlightedEdgeIds.has(id))
        if (allHighlighted && edgeIds.length > 0) {
            clearHighlightedEdges()
        } else {
            setHighlightedEdges(edgeIds)
        }
    }

    // Check if edge type is visible
    const isTypeVisible = (type: string) => {
        const filter = filters.find((f) => f.type === type)
        return filter?.enabled ?? true
    }

    return (
        <div className={cn("glass-panel rounded-xl overflow-hidden", className)}>
            {/* Header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-accent-lineage" />
                    <span className="text-sm font-medium">Edge Legend</span>
                    <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5">
                        {edges.length} edges
                    </span>
                </div>
                {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-ink-muted" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-ink-muted" />
                )}
            </button>

            {/* Legend Content */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                    >
                        <div className="px-3 pb-3 space-y-1.5">
                            {activeEdgeTypes.length === 0 ? (
                                <p className="text-xs text-ink-muted py-2">No edges to display</p>
                            ) : (
                                activeEdgeTypes.map((def) => {
                                    const count = edgeCountsByType[def.type] ?? 0
                                    const isVisible = isTypeVisible(def.type)
                                    const isHighlighted = edges
                                        .filter((e) => (e.data?.edgeType ?? e.data?.relationship) === def.type)
                                        .some((e) => highlightedEdgeIds.has(e.id))

                                    return (
                                        <div
                                            key={def.type}
                                            className={cn(
                                                "flex items-center gap-2 p-2 rounded-lg transition-all cursor-pointer",
                                                "hover:bg-black/5 dark:hover:bg-white/5",
                                                isHighlighted && "bg-accent-lineage/10 ring-1 ring-accent-lineage/30"
                                            )}
                                            onClick={() => handleHighlightType(def.type)}
                                        >
                                            {/* Edge Line Sample */}
                                            <div className="flex items-center w-12">
                                                <svg width="48" height="8" viewBox="0 0 48 8">
                                                    <line
                                                        x1="0"
                                                        y1="4"
                                                        x2="48"
                                                        y2="4"
                                                        stroke={def.color}
                                                        strokeWidth="2"
                                                        strokeDasharray={
                                                            def.strokeStyle === 'dashed' ? '6,3' :
                                                                def.strokeStyle === 'dotted' ? '2,2' : 'none'
                                                        }
                                                    />
                                                    {/* Arrow head */}
                                                    <polygon
                                                        points="42,1 48,4 42,7"
                                                        fill={def.color}
                                                    />
                                                </svg>
                                            </div>

                                            {/* Icon & Label */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span style={{ color: def.color }}>{def.icon}</span>
                                                    <span className="text-xs font-medium">{def.label}</span>
                                                    {def.animated && (
                                                        <span className="text-2xs text-ink-muted">●</span>
                                                    )}
                                                </div>
                                                <p className="text-2xs text-ink-muted truncate">{def.description}</p>
                                            </div>

                                            {/* Count */}
                                            <span className="text-xs font-medium text-ink-muted tabular-nums">
                                                {count}
                                            </span>

                                            {/* Visibility Toggle */}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    toggleFilter(def.type)
                                                }}
                                                className={cn(
                                                    "p-1 rounded transition-colors",
                                                    isVisible
                                                        ? "text-accent-lineage hover:bg-accent-lineage/10"
                                                        : "text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                                                )}
                                                title={isVisible ? "Hide edges" : "Show edges"}
                                            >
                                                {isVisible ? (
                                                    <Eye className="w-3.5 h-3.5" />
                                                ) : (
                                                    <EyeOff className="w-3.5 h-3.5" />
                                                )}
                                            </button>
                                        </div>
                                    )
                                })
                            )}

                            {/* Tip for new users */}
                            <div className="mt-2 pt-2 border-t border-glass-border">
                                <p className="text-2xs text-ink-muted">
                                    💡 Click a row to highlight edges of that type
                                </p>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

export default EdgeLegend
