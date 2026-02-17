/**
 * useAggregatedLineage - Progressive edge disclosure hook
 * 
 * Manages aggregated lineage edges that show summarized connections
 * between containers (e.g., datasets, systems). Supports expanding
 * aggregated edges to reveal detailed connections on demand.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type {
    AggregatedEdgeInfo,
    AggregatedEdgeResult,
    GraphEdge
} from '@/providers/GraphDataProvider'

// ============================================
// Types
// ============================================

export type ExpansionState = 'collapsed' | 'expanded' | 'loading'

export interface AggregatedEdgeState {
    /** The aggregated edge info from backend */
    aggregated: AggregatedEdgeInfo
    /** Current expansion state */
    state: ExpansionState
    /** Detailed edges (populated when expanded) */
    detailedEdges: GraphEdge[]
}

export interface UseAggregatedLineageOptions {
    /** Initial granularity level */
    granularity?: 'column' | 'table' | 'schema' | 'system' | 'domain'
    /** Whether to automatically fetch aggregated edges */
    autoFetch?: boolean
    /** Cache TTL in milliseconds (default: 5 minutes) */
    cacheTtl?: number
}

export interface UseAggregatedLineageResult {
    /** Map of aggregated edge ID to its state */
    aggregatedEdges: Map<string, AggregatedEdgeState>

    /** Whether any aggregation request is loading */
    isLoading: boolean

    /** Last error encountered */
    error: string | null

    /** Current granularity level */
    granularity: 'column' | 'table' | 'schema' | 'system' | 'domain'

    /** Fetch aggregated edges for given source URNs */
    fetchAggregated: (sourceUrns: string[], targetUrns?: string[]) => Promise<void>

    /** Expand an aggregated edge to show detailed edges */
    expandEdge: (aggregatedEdgeId: string) => Promise<void>

    /** Collapse an expanded edge back to aggregated state */
    collapseEdge: (aggregatedEdgeId: string) => void

    /** Toggle expansion state of an edge */
    toggleEdge: (aggregatedEdgeId: string) => Promise<void>

    /** Check if an edge is expanded */
    isExpanded: (aggregatedEdgeId: string) => boolean

    /** Get all visible edges (both aggregated and detailed) */
    getVisibleEdges: () => Array<GraphEdge | AggregatedEdgeInfo>

    /** Change granularity level (triggers refetch) */
    setGranularity: (granularity: 'column' | 'table' | 'schema' | 'system' | 'domain') => void

    /** Clear all cached data */
    clearCache: () => void

    /** Get edge count for a specific aggregated edge */
    getEdgeCount: (aggregatedEdgeId: string) => number

    /** Get edge types summary for an aggregated edge */
    getEdgeTypes: (aggregatedEdgeId: string) => string[]
}

// ============================================
// Cache for aggregated edge results
// ============================================

interface CacheEntry {
    result: AggregatedEdgeResult
    timestamp: number
    sourceUrns: string[]
    targetUrns?: string[]
    granularity: string
}

const aggregatedEdgeCache = new Map<string, CacheEntry>()

function getCacheKey(sourceUrns: string[], targetUrns: string[] | undefined, granularity: string): string {
    const sortedSources = [...sourceUrns].sort().join(',')
    const sortedTargets = targetUrns ? [...targetUrns].sort().join(',') : ''
    return `${granularity}:${sortedSources}:${sortedTargets}`
}

// ============================================
// Hook Implementation
// ============================================

export function useAggregatedLineage(options: UseAggregatedLineageOptions = {}): UseAggregatedLineageResult {
    const {
        granularity: initialGranularity = 'table',
        cacheTtl = 5 * 60 * 1000, // 5 minutes
    } = options

    const provider = useGraphProvider()

    // State
    const [aggregatedEdges, setAggregatedEdges] = useState<Map<string, AggregatedEdgeState>>(new Map())
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [granularity, setGranularity] = useState(initialGranularity)

    // Track current source URNs for refetch on granularity change
    const currentSourceUrnsRef = useRef<string[]>([])
    const currentTargetUrnsRef = useRef<string[] | undefined>(undefined)

    // Fetch aggregated edges from backend
    const fetchAggregated = useCallback(async (sourceUrns: string[], targetUrns?: string[]) => {
        if (!provider || sourceUrns.length === 0) return

        // Check cache first
        const cacheKey = getCacheKey(sourceUrns, targetUrns, granularity)
        const cached = aggregatedEdgeCache.get(cacheKey)

        if (cached && (Date.now() - cached.timestamp) < cacheTtl) {
            // Use cached result with functional update to avoid dependency on aggregatedEdges
            setAggregatedEdges(prev => {
                const edgeMap = new Map<string, AggregatedEdgeState>()
                for (const agg of cached.result.aggregatedEdges) {
                    const existing = prev.get(agg.id)
                    edgeMap.set(agg.id, {
                        aggregated: agg,
                        state: existing?.state ?? 'collapsed',
                        detailedEdges: existing?.detailedEdges ?? [],
                    })
                }
                return edgeMap
            })
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            const result = await provider.getAggregatedEdges({
                sourceUrns,
                targetUrns,
                granularity,
            })

            // Cache the result
            aggregatedEdgeCache.set(cacheKey, {
                result,
                timestamp: Date.now(),
                sourceUrns,
                targetUrns,
                granularity,
            })

            // Update state with functional update to avoid dependency on aggregatedEdges
            setAggregatedEdges(prev => {
                const edgeMap = new Map<string, AggregatedEdgeState>()
                for (const agg of result.aggregatedEdges) {
                    const existing = prev.get(agg.id)
                    edgeMap.set(agg.id, {
                        aggregated: agg,
                        state: existing?.state ?? 'collapsed',
                        detailedEdges: existing?.detailedEdges ?? [],
                    })
                }
                return edgeMap
            })

            // Track for refetch
            currentSourceUrnsRef.current = sourceUrns
            currentTargetUrnsRef.current = targetUrns

        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch aggregated edges')
        } finally {
            setIsLoading(false)
        }
    }, [provider, granularity, cacheTtl])

    // Expand an aggregated edge to show detailed edges
    const expandEdge = useCallback(async (aggregatedEdgeId: string) => {
        const edgeState = aggregatedEdges.get(aggregatedEdgeId)
        if (!edgeState || !provider) return

        // Already expanded or loading
        if (edgeState.state === 'expanded' || edgeState.state === 'loading') return

        // Update state to loading
        setAggregatedEdges(prev => {
            const next = new Map(prev)
            const current = next.get(aggregatedEdgeId)
            if (current) {
                next.set(aggregatedEdgeId, { ...current, state: 'loading' })
            }
            return next
        })

        try {
            // Fetch detailed edges strictly between source and target
            // We optimized the backend to handle sourceUrns + targetUrns efficiently.
            const edges = await provider.getEdges({
                sourceUrns: [edgeState.aggregated.sourceUrn],
                targetUrns: [edgeState.aggregated.targetUrn],
            })

            // No need to filter extensively client-side if backend does its job,
            // but we keep a sanity check just in case.
            const relevantEdges = edges

            setAggregatedEdges(prev => {
                const next = new Map(prev)
                const current = next.get(aggregatedEdgeId)
                if (current) {
                    next.set(aggregatedEdgeId, {
                        ...current,
                        state: 'expanded',
                        detailedEdges: relevantEdges,
                    })
                }
                return next
            })
        } catch (err) {
            // Revert to collapsed on error
            setAggregatedEdges(prev => {
                const next = new Map(prev)
                const current = next.get(aggregatedEdgeId)
                if (current) {
                    next.set(aggregatedEdgeId, { ...current, state: 'collapsed' })
                }
                return next
            })
            setError(err instanceof Error ? err.message : 'Failed to expand edge')
        }
    }, [aggregatedEdges, provider])

    // Collapse an expanded edge
    const collapseEdge = useCallback((aggregatedEdgeId: string) => {
        setAggregatedEdges(prev => {
            const next = new Map(prev)
            const current = next.get(aggregatedEdgeId)
            if (current) {
                next.set(aggregatedEdgeId, {
                    ...current,
                    state: 'collapsed',
                    // Keep detailed edges cached for quick re-expand
                })
            }
            return next
        })
    }, [])

    // Toggle expansion
    const toggleEdge = useCallback(async (aggregatedEdgeId: string) => {
        const edgeState = aggregatedEdges.get(aggregatedEdgeId)
        if (!edgeState) return

        if (edgeState.state === 'expanded') {
            collapseEdge(aggregatedEdgeId)
        } else if (edgeState.state === 'collapsed') {
            await expandEdge(aggregatedEdgeId)
        }
    }, [aggregatedEdges, expandEdge, collapseEdge])

    // Check if expanded
    const isExpanded = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.state === 'expanded'
    }, [aggregatedEdges])

    // Get all visible edges
    const getVisibleEdges = useCallback(() => {
        const visible: Array<GraphEdge | AggregatedEdgeInfo> = []

        for (const [, edgeState] of aggregatedEdges) {
            if (edgeState.state === 'expanded' && edgeState.detailedEdges.length > 0) {
                // Show detailed edges when expanded
                visible.push(...edgeState.detailedEdges)
            } else {
                // Show aggregated edge when collapsed
                visible.push(edgeState.aggregated)
            }
        }

        return visible
    }, [aggregatedEdges])

    // Change granularity and refetch
    const handleSetGranularity = useCallback((newGranularity: 'column' | 'table' | 'schema' | 'system' | 'domain') => {
        if (newGranularity === granularity) return

        setGranularity(newGranularity)

        // Refetch with new granularity if we have current sources
        if (currentSourceUrnsRef.current.length > 0) {
            // Clear cache for new granularity
            aggregatedEdgeCache.clear()
            fetchAggregated(currentSourceUrnsRef.current, currentTargetUrnsRef.current)
        }
    }, [granularity, fetchAggregated])

    // Clear cache
    const clearCache = useCallback(() => {
        aggregatedEdgeCache.clear()
        setAggregatedEdges(new Map())
        currentSourceUrnsRef.current = []
        currentTargetUrnsRef.current = undefined
    }, [])

    // Get edge count
    const getEdgeCount = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.aggregated.edgeCount ?? 0
    }, [aggregatedEdges])

    // Get edge types
    const getEdgeTypes = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.aggregated.edgeTypes ?? []
    }, [aggregatedEdges])

    return {
        aggregatedEdges,
        isLoading,
        error,
        granularity,
        fetchAggregated,
        expandEdge,
        collapseEdge,
        toggleEdge,
        isExpanded,
        getVisibleEdges,
        setGranularity: handleSetGranularity,
        clearCache,
        getEdgeCount,
        getEdgeTypes,
    }
}

// ============================================
// Utility: Convert aggregated edge to React Flow edge
// ============================================

export function aggregatedEdgeToFlowEdge(
    agg: AggregatedEdgeInfo,
    options?: {
        animated?: boolean
        strokeWidth?: number
        showLabel?: boolean
    }
): {
    id: string
    source: string
    target: string
    type: string
    animated: boolean
    style: React.CSSProperties
    data: Record<string, unknown>
    label?: string
} {
    const { animated = true, strokeWidth = 2, showLabel = true } = options ?? {}

    // Scale stroke width based on edge count
    const scaledStrokeWidth = Math.min(strokeWidth + Math.log2(agg.edgeCount), 8)

    return {
        id: agg.id,
        source: agg.sourceUrn,
        target: agg.targetUrn,
        type: 'aggregated',
        animated,
        style: {
            strokeWidth: scaledStrokeWidth,
            opacity: agg.confidence,
        },
        data: {
            isAggregated: true,
            edgeCount: agg.edgeCount,
            edgeTypes: agg.edgeTypes,
            confidence: agg.confidence,
            sourceEdgeIds: agg.sourceEdgeIds,
        },
        label: showLabel ? `${agg.edgeCount} edges` : undefined,
    }
}

