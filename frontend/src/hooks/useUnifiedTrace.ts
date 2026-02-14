/**
 * useUnifiedTrace - Unified trace functionality across all canvas views
 * 
 * Consolidates trace logic from ReferenceModelCanvas and LineageCanvas
 * into a single reusable hook with configurable depth and direction.
 */

import { create } from 'zustand'
import { useCallback, useMemo } from 'react'
import type { GraphDataProvider, LineageResult } from '@/providers/GraphDataProvider'

// ============================================
// Types
// ============================================

export type TraceDirection = 'upstream' | 'downstream' | 'both'
export type TraceStatus = 'idle' | 'loading' | 'success' | 'error'

export interface TraceConfig {
    /** Maximum depth for upstream traversal (1-99) */
    upstreamDepth: number
    /** Maximum depth for downstream traversal (1-99) */
    downstreamDepth: number
    /** Include column-level lineage in trace */
    includeColumnLineage: boolean
    /** Auto-expand ancestors when tracing */
    autoExpandAncestors: boolean
    /** Show only the traced path vs show with context */
    pathOnly: boolean
}

export interface TraceResult {
    /** The node being traced from */
    focusId: string
    /** All nodes in the trace */
    traceNodes: Set<string>
    /** Upstream nodes only */
    upstreamNodes: Set<string>
    /** Downstream nodes only */
    downstreamNodes: Set<string>
    /** All edges in the trace */
    traceEdges: Set<string>
    /** Raw lineage result from backend */
    lineageResult: LineageResult | null
}

export interface TraceState {
    /** Current trace status */
    status: TraceStatus
    /** Error message if failed */
    error: string | null
    /** Current focus node ID (if tracing) */
    focusId: string | null
    /** Current trace result */
    result: TraceResult | null
    /** Trace configuration */
    config: TraceConfig
    /** Direction toggle states */
    showUpstream: boolean
    showDownstream: boolean
    
    // Actions
    setFocus: (nodeId: string | null) => void
    setConfig: (config: Partial<TraceConfig>) => void
    setShowUpstream: (show: boolean) => void
    setShowDownstream: (show: boolean) => void
    fetchTrace: (nodeId: string, provider: GraphDataProvider, urnResolver?: (id: string) => string) => Promise<TraceResult | null>
    clearTrace: () => void
    reset: () => void
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: TraceConfig = {
    upstreamDepth: 5,
    downstreamDepth: 5,
    includeColumnLineage: true,
    autoExpandAncestors: true,
    pathOnly: false,
}

// ============================================
// Zustand Store
// ============================================

export const useTraceStore = create<TraceState>((set, get) => ({
    status: 'idle',
    error: null,
    focusId: null,
    result: null,
    config: DEFAULT_CONFIG,
    showUpstream: true,
    showDownstream: true,
    
    setFocus: (nodeId) => {
        if (nodeId === null) {
            // Clear trace
            set({ focusId: null, result: null, status: 'idle' })
        } else {
            set({ focusId: nodeId })
        }
    },
    
    setConfig: (config) => {
        set(state => ({
            config: { ...state.config, ...config }
        }))
    },
    
    setShowUpstream: (show) => set({ showUpstream: show }),
    setShowDownstream: (show) => set({ showDownstream: show }),
    
    fetchTrace: async (nodeId, provider, urnResolver) => {
        const { config } = get()
        
        set({ status: 'loading', error: null, focusId: nodeId })
        
        try {
            // Resolve URN from node ID
            const urn = urnResolver ? urnResolver(nodeId) : nodeId
            
            // Fetch full lineage from provider
            const result = await provider.getFullLineage(
                urn,
                config.upstreamDepth,
                config.downstreamDepth,
                config.includeColumnLineage
            )
            
            // Build trace result
            const traceNodes = new Set<string>()
            const upstreamNodes = new Set<string>()
            const downstreamNodes = new Set<string>()
            const traceEdges = new Set<string>()
            
            // Add focus node
            traceNodes.add(nodeId)
            
            // Process nodes
            result.nodes.forEach(n => {
                traceNodes.add(n.urn)
            })
            
            // Process upstream/downstream URNs
            result.upstreamUrns.forEach(urn => {
                traceNodes.add(urn)
                upstreamNodes.add(urn)
            })
            
            result.downstreamUrns.forEach(urn => {
                traceNodes.add(urn)
                downstreamNodes.add(urn)
            })
            
            // Process edges
            result.edges.forEach(e => {
                traceEdges.add(e.id)
            })
            
            const traceResult: TraceResult = {
                focusId: nodeId,
                traceNodes,
                upstreamNodes,
                downstreamNodes,
                traceEdges,
                lineageResult: result,
            }
            
            set({
                status: 'success',
                result: traceResult,
            })
            
            return traceResult
        } catch (err) {
            set({
                status: 'error',
                error: err instanceof Error ? err.message : 'Failed to fetch trace',
            })
            return null
        }
    },
    
    clearTrace: () => {
        set({
            focusId: null,
            result: null,
            status: 'idle',
            error: null,
            showUpstream: true,
            showDownstream: true,
        })
    },
    
    reset: () => {
        set({
            status: 'idle',
            error: null,
            focusId: null,
            result: null,
            config: DEFAULT_CONFIG,
            showUpstream: true,
            showDownstream: true,
        })
    },
}))

// ============================================
// Hook
// ============================================

export interface UseUnifiedTraceOptions {
    /** Graph data provider */
    provider: GraphDataProvider | null
    /** Function to resolve node ID to URN */
    urnResolver?: (nodeId: string) => string
    /** Callback when trace is completed */
    onTraceComplete?: (result: TraceResult) => void
}

export interface UseUnifiedTraceResult {
    /** Current trace status */
    status: TraceStatus
    /** Error message if failed */
    error: string | null
    /** Current focus node ID */
    focusId: string | null
    /** Current trace result */
    result: TraceResult | null
    /** Is trace active */
    isTracing: boolean
    /** Is loading */
    isLoading: boolean
    
    /** Trace configuration */
    config: TraceConfig
    /** Update configuration */
    setConfig: (config: Partial<TraceConfig>) => void
    
    /** Direction visibility */
    showUpstream: boolean
    showDownstream: boolean
    setShowUpstream: (show: boolean) => void
    setShowDownstream: (show: boolean) => void
    
    /** Start trace from a node */
    startTrace: (nodeId: string) => Promise<void>
    /** Toggle trace on a node (start if not active, clear if same node) */
    toggleTrace: (nodeId: string) => Promise<void>
    /** Clear current trace */
    clearTrace: () => void
    
    /** Check if a node is in the trace */
    isInTrace: (nodeId: string) => boolean
    /** Check if a node is upstream */
    isUpstream: (nodeId: string) => boolean
    /** Check if a node is downstream */
    isDownstream: (nodeId: string) => boolean
    /** Check if a node is the focus */
    isFocus: (nodeId: string) => boolean
    
    /** Get visible trace nodes (filtered by direction toggles) */
    visibleTraceNodes: Set<string>
    /** Get trace context (includes ancestors for dimming logic) */
    traceContextSet: Set<string>
    
    /** Upstream count */
    upstreamCount: number
    /** Downstream count */
    downstreamCount: number
}

export function useUnifiedTrace(options: UseUnifiedTraceOptions): UseUnifiedTraceResult {
    const { provider, urnResolver, onTraceComplete } = options
    
    // Get store state
    const status = useTraceStore(s => s.status)
    const error = useTraceStore(s => s.error)
    const focusId = useTraceStore(s => s.focusId)
    const result = useTraceStore(s => s.result)
    const config = useTraceStore(s => s.config)
    const showUpstream = useTraceStore(s => s.showUpstream)
    const showDownstream = useTraceStore(s => s.showDownstream)
    
    // Actions
    const setConfig = useTraceStore(s => s.setConfig)
    const setShowUpstream = useTraceStore(s => s.setShowUpstream)
    const setShowDownstream = useTraceStore(s => s.setShowDownstream)
    const fetchTrace = useTraceStore(s => s.fetchTrace)
    const clearTrace = useTraceStore(s => s.clearTrace)
    const setFocus = useTraceStore(s => s.setFocus)
    
    // Derived state
    const isTracing = focusId !== null
    const isLoading = status === 'loading'
    
    // Start trace
    const startTrace = useCallback(async (nodeId: string) => {
        if (!provider) return
        
        const traceResult = await fetchTrace(nodeId, provider, urnResolver)
        
        if (traceResult && onTraceComplete) {
            onTraceComplete(traceResult)
        }
    }, [provider, urnResolver, fetchTrace, onTraceComplete])
    
    // Toggle trace
    const toggleTrace = useCallback(async (nodeId: string) => {
        if (focusId === nodeId) {
            clearTrace()
        } else {
            await startTrace(nodeId)
        }
    }, [focusId, clearTrace, startTrace])
    
    // Check functions
    const isInTrace = useCallback((nodeId: string) => {
        return result?.traceNodes.has(nodeId) ?? false
    }, [result])
    
    const isUpstream = useCallback((nodeId: string) => {
        return result?.upstreamNodes.has(nodeId) ?? false
    }, [result])
    
    const isDownstream = useCallback((nodeId: string) => {
        return result?.downstreamNodes.has(nodeId) ?? false
    }, [result])
    
    const isFocus = useCallback((nodeId: string) => {
        return focusId === nodeId
    }, [focusId])
    
    // Visible trace nodes (filtered by direction)
    const visibleTraceNodes = useMemo(() => {
        if (!result) return new Set<string>()
        
        const visible = new Set<string>()
        
        // Always include focus
        if (focusId) visible.add(focusId)
        
        result.traceNodes.forEach(nodeId => {
            const isUp = result.upstreamNodes.has(nodeId)
            const isDown = result.downstreamNodes.has(nodeId)
            const isFocusNode = nodeId === focusId
            
            // Include if focus, or if direction is enabled
            if (isFocusNode) {
                visible.add(nodeId)
            } else if (isUp && showUpstream) {
                visible.add(nodeId)
            } else if (isDown && showDownstream) {
                visible.add(nodeId)
            } else if (!isUp && !isDown) {
                // Nodes that are neither upstream nor downstream but in trace
                // (e.g., intermediate nodes) - show if either direction is on
                if (showUpstream || showDownstream) {
                    visible.add(nodeId)
                }
            }
        })
        
        return visible
    }, [result, focusId, showUpstream, showDownstream])
    
    // Trace context set (includes ancestors for proper highlighting)
    const traceContextSet = useMemo(() => {
        // For now, same as visible trace nodes
        // Could be extended to include ancestors for container highlighting
        return visibleTraceNodes
    }, [visibleTraceNodes])
    
    // Counts
    const upstreamCount = result?.upstreamNodes.size ?? 0
    const downstreamCount = result?.downstreamNodes.size ?? 0
    
    return {
        status,
        error,
        focusId,
        result,
        isTracing,
        isLoading,
        config,
        setConfig,
        showUpstream,
        showDownstream,
        setShowUpstream,
        setShowDownstream,
        startTrace,
        toggleTrace,
        clearTrace,
        isInTrace,
        isUpstream,
        isDownstream,
        isFocus,
        visibleTraceNodes,
        traceContextSet,
        upstreamCount,
        downstreamCount,
    }
}

// ============================================
// Utility Selectors
// ============================================

export const useTraceConfig = () => useTraceStore(s => s.config)
export const useTraceFocusId = () => useTraceStore(s => s.focusId)
export const useTraceStatus = () => useTraceStore(s => s.status)
export const useIsTracing = () => useTraceStore(s => s.focusId !== null)

