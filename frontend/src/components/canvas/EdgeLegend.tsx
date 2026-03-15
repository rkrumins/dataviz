/**
 * EdgeLegend - Displays a legend explaining edge types, colors, and meanings
 *
 * Operates in two modes:
 * - Canvas mode (no visibleEdges prop): uses raw canvas store edges
 * - Context View mode (visibleEdges provided): uses projected/aggregated edges
 *   from the canvas render pipeline, which have a different data structure
 *   (edge.types[] array + edge.edgeCount bundle count)
 */

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { GitBranch, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useEdgeFiltersStore } from '@/hooks/useEdgeFilters'
import { useSchemaStore, useContainmentEdgeTypes, useRelationshipTypes } from '@/store/schema'
import { getAllEdgeTypeDefinitions, normalizeEdgeType } from '@/utils/edgeTypeUtils'

// ─── Data-shape helpers ───────────────────────────────────────────────────────
// Projected edges (from useEdgeProjection) carry a `types: string[]` array and
// an `edgeCount` representing how many underlying lineage edges are bundled.
// Canvas store edges carry `data.edgeType` (string) and count as 1 each.

function edgeTypesOf(edge: any): string[] {
    if (Array.isArray(edge.types) && edge.types.length > 0) return edge.types
    if (Array.isArray(edge.data?.edgeTypes) && edge.data.edgeTypes.length > 0) return edge.data.edgeTypes
    const normalized = normalizeEdgeType(edge)
    return normalized ? [normalized] : []
}

function edgeBundleCount(edge: any): number {
    return typeof edge.edgeCount === 'number' && edge.edgeCount > 0 ? edge.edgeCount : 1
}

// ─── Component ───────────────────────────────────────────────────────────────

interface EdgeLegendProps {
    className?: string
    defaultExpanded?: boolean
    /**
     * Projected/rendered edges for this view (from useEdgeProjection).
     * When provided, the legend enters Context View mode and derives all type
     * discovery, counts, and highlighting from these edges instead of the
     * raw canvas store.
     */
    visibleEdges?: any[]
}

export function EdgeLegend({ className, defaultExpanded = false, visibleEdges }: EdgeLegendProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded)

    const storeEdges = useCanvasStore((s) => s.edges)
    const relationshipTypes = useRelationshipTypes()
    const containmentEdgeTypes = useContainmentEdgeTypes()

    const {
        highlightedEdgeIds,
        setHighlightedEdges,
        clearHighlightedEdges,
        filters,
        toggleFilter,
    } = useEdgeFiltersStore()

    // In Context View mode we work from projected edges; otherwise raw store edges.
    const isProjectedMode = visibleEdges !== undefined
    const activeEdges = isProjectedMode ? (visibleEdges ?? []) : storeEdges

    // Edge type metadata (color, label, icon, stroke style) always comes from
    // the store — the schema-driven definitions live there regardless of mode.
    const edgeTypeDefinitions = useMemo(() => {
        return getAllEdgeTypeDefinitions(
            storeEdges,
            relationshipTypes,
            containmentEdgeTypes,
        )
    }, [storeEdges, relationshipTypes, containmentEdgeTypes])

    // Per-type counts from the *active* edge list.
    // For projected edges each entry may represent multiple underlying edges
    // (edge.edgeCount), so we sum those to get meaningful counts.
    const countsByType = useMemo(() => {
        const counts: Record<string, number> = {}
        activeEdges.forEach(edge => {
            const types = edgeTypesOf(edge)
            const n = edgeBundleCount(edge)
            types.forEach(t => {
                const key = t.toUpperCase()
                counts[key] = (counts[key] ?? 0) + n
            })
        })
        return counts
    }, [activeEdges])

    // Types present in the active edge set.
    // In projected mode we build rows from countsByType directly — the projected
    // edges may include synthetic types (e.g. "AGGREGATED") that have no entry in
    // the schema-based edgeTypeDefinitions.  Building from countsByType guarantees
    // that sum(row counts) == header total.
    const activeEdgeTypes = useMemo(() => {
        if (isProjectedMode) {
            return Object.entries(countsByType).map(([typeKey]) => {
                const schemaDef = edgeTypeDefinitions.find(
                    d => d.type.toUpperCase() === typeKey
                )
                return schemaDef ?? {
                    type: typeKey,
                    label: typeKey,
                    color: '#6b7280',
                    description: `Relationship type: ${typeKey}`,
                    strokeStyle: 'solid' as const,
                    animated: false,
                    icon: null,
                }
            }).sort((a, b) => (countsByType[b.type.toUpperCase()] ?? 0) - (countsByType[a.type.toUpperCase()] ?? 0))
        }
        return edgeTypeDefinitions.filter(
            def => (countsByType[def.type.toUpperCase()] ?? 0) > 0
        )
    }, [isProjectedMode, edgeTypeDefinitions, countsByType])

    // Total = sum of all type row counts — always consistent with what the rows show.
    const totalOnScreen = useMemo(
        () => Object.values(countsByType).reduce((s, n) => s + n, 0),
        [countsByType]
    )

    // Click a type row → highlight all edges of that type in the overlay.
    const handleHighlightType = (type: string) => {
        const upper = type.toUpperCase()
        const matchingIds = activeEdges
            .filter(e => edgeTypesOf(e).some(t => t.toUpperCase() === upper))
            .map(e => e.id)

        const allHighlighted = matchingIds.length > 0 && matchingIds.every(id => highlightedEdgeIds.has(id))
        if (allHighlighted) {
            clearHighlightedEdges()
        } else {
            setHighlightedEdges(matchingIds)
        }
    }

    const isTypeHighlighted = (type: string) => {
        const upper = type.toUpperCase()
        return activeEdges
            .filter(e => edgeTypesOf(e).some(t => t.toUpperCase() === upper))
            .some(e => highlightedEdgeIds.has(e.id))
    }

    const isTypeVisible = (type: string) => {
        const filter = filters.find(f => f.type.toUpperCase() === type.toUpperCase())
        return filter?.enabled ?? true
    }

    // ─── Header summary string ────────────────────────────────────────────────
    // Context View: "X relationships on screen" (sum of bundled counts)
    // Canvas mode:  "X edges" (raw count)
    const headerSummary = isProjectedMode
        ? totalOnScreen === 0
            ? 'No edges on screen'
            : `${totalOnScreen.toLocaleString()} on screen`
        : `${storeEdges.length} edges`

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
                    <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 tabular-nums">
                        {headerSummary}
                    </span>
                </div>
                {isExpanded
                    ? <ChevronUp className="w-4 h-4 text-ink-muted" />
                    : <ChevronDown className="w-4 h-4 text-ink-muted" />
                }
            </button>

            {/* Legend content */}
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
                                <p className="text-xs text-ink-muted py-3 text-center">
                                    {isProjectedMode ? 'No edges visible in this view' : 'No edges to display'}
                                </p>
                            ) : (
                                activeEdgeTypes.map(def => {
                                    const typeKey = def.type.toUpperCase()
                                    const count = countsByType[typeKey] ?? 0
                                    const isVisible = isTypeVisible(def.type)
                                    const isHighlighted = isTypeHighlighted(def.type)

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
                                            {/* Edge line sample */}
                                            <div className="flex items-center w-12 flex-shrink-0">
                                                <svg width="48" height="8" viewBox="0 0 48 8">
                                                    <line
                                                        x1="0" y1="4" x2="42" y2="4"
                                                        stroke={def.color}
                                                        strokeWidth="2"
                                                        strokeDasharray={
                                                            def.strokeStyle === 'dashed' ? '6,3' :
                                                            def.strokeStyle === 'dotted' ? '2,2' : 'none'
                                                        }
                                                    />
                                                    <polygon points="42,1 48,4 42,7" fill={def.color} />
                                                </svg>
                                            </div>

                                            {/* Label + description */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span style={{ color: def.color }}>{def.icon}</span>
                                                    <span className="text-xs font-medium truncate">{def.label}</span>
                                                    {def.animated && (
                                                        <span className="text-2xs text-ink-muted flex-shrink-0">●</span>
                                                    )}
                                                </div>
                                                <p className="text-2xs text-ink-muted truncate">{def.description}</p>
                                            </div>

                                            {/* Count — represents underlying relationships, not bundle objects */}
                                            <span className="text-xs font-semibold text-ink-muted tabular-nums flex-shrink-0">
                                                {count.toLocaleString()}
                                            </span>

                                            {/* Visibility toggle */}
                                            <button
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    const filter = filters.find(f =>
                                                        f.type.toUpperCase() === def.type.toUpperCase()
                                                    )
                                                    toggleFilter(filter ? filter.type : def.type.toLowerCase())
                                                }}
                                                className={cn(
                                                    "p-1 rounded transition-colors flex-shrink-0",
                                                    isVisible
                                                        ? "text-accent-lineage hover:bg-accent-lineage/10"
                                                        : "text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                                                )}
                                                title={isVisible ? "Hide this edge type" : "Show this edge type"}
                                            >
                                                {isVisible
                                                    ? <Eye className="w-3.5 h-3.5" />
                                                    : <EyeOff className="w-3.5 h-3.5" />
                                                }
                                            </button>
                                        </div>
                                    )
                                })
                            )}

                            <div className="mt-2 pt-2 border-t border-glass-border">
                                <p className="text-2xs text-ink-muted">
                                    💡 Click a row to highlight all edges of that type
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
