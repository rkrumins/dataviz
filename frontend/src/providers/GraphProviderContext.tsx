/**
 * GraphProviderContext - React context for graph data provider
 * 
 * Allows injection of different graph data providers (Mock, FalkorDB, DataHub)
 * at the application root level.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { GraphDataProvider, GraphProviderContextValue } from './GraphDataProvider'
import { getMockProvider } from './MockProvider'

// ============================================
// Context
// ============================================

const GraphProviderContext = createContext<GraphProviderContextValue | null>(null)

// ============================================
// Provider Component
// ============================================

interface GraphProviderProps {
    /** Optional custom provider (defaults to MockProvider) */
    provider?: GraphDataProvider
    children: ReactNode
}

export function GraphProvider({ provider, children }: GraphProviderProps) {
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [currentProvider, setCurrentProvider] = useState<GraphDataProvider | null>(null)

    useEffect(() => {
        const initProvider = async () => {
            try {
                setIsLoading(true)
                setError(null)

                // Use provided provider or default to MockProvider
                const p = provider ?? getMockProvider()

                // Verify provider is working by fetching stats
                await p.getStats()

                setCurrentProvider(p)
            } catch (err) {
                setError(err instanceof Error ? err : new Error('Failed to initialize provider'))
            } finally {
                setIsLoading(false)
            }
        }

        initProvider()
    }, [provider])

    // Show nothing while loading
    if (!currentProvider && isLoading) {
        return null
    }

    const value: GraphProviderContextValue = {
        provider: currentProvider ?? getMockProvider(),
        isLoading,
        error,
    }

    return (
        <GraphProviderContext.Provider value={value}>
            {children}
        </GraphProviderContext.Provider>
    )
}

// ============================================
// Hook
// ============================================

/**
 * Access the current graph data provider
 */
export function useGraphProvider(): GraphDataProvider {
    const context = useContext(GraphProviderContext)

    if (!context) {
        // If not wrapped in provider, return mock provider
        console.warn('useGraphProvider: No GraphProvider found, using MockProvider')
        return getMockProvider()
    }

    return context.provider
}

/**
 * Access the full provider context including loading/error state
 */
export function useGraphProviderContext(): GraphProviderContextValue {
    const context = useContext(GraphProviderContext)

    if (!context) {
        return {
            provider: getMockProvider(),
            isLoading: false,
            error: null,
        }
    }

    return context
}

// ============================================
// Async Query Hooks
// ============================================

import { useCallback } from 'react'
import type { GraphNode, URN, LineageResult } from './GraphDataProvider'

/**
 * Hook for fetching a single node
 */
export function useNode(urn: URN | null | undefined) {
    const provider = useGraphProvider()
    const [node, setNode] = useState<GraphNode | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    useEffect(() => {
        if (!urn) {
            setNode(null)
            return
        }

        let cancelled = false
        setLoading(true)

        provider.getNode(urn)
            .then((result) => {
                if (!cancelled) {
                    setNode(result)
                    setError(null)
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err)
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false)
                }
            })

        return () => { cancelled = true }
    }, [urn, provider])

    return { node, loading, error }
}

/**
 * Hook for fetching children of a node
 */
export function useChildren(parentUrn: URN | null | undefined) {
    const provider = useGraphProvider()
    const [children, setChildren] = useState<GraphNode[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    const refetch = useCallback(async () => {
        if (!parentUrn) {
            setChildren([])
            return
        }

        setLoading(true)
        try {
            const result = await provider.getChildren(parentUrn)
            setChildren(result)
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Failed to fetch children'))
        } finally {
            setLoading(false)
        }
    }, [parentUrn, provider])

    useEffect(() => {
        refetch()
    }, [refetch])

    return { children, loading, error, refetch }
}

/**
 * Hook for lineage traversal
 */
export function useLineage(
    urn: URN | null | undefined,
    options: {
        upstreamDepth?: number
        downstreamDepth?: number
        includeColumnLineage?: boolean
        enabled?: boolean
    } = {}
) {
    const {
        upstreamDepth = 3,
        downstreamDepth = 3,
        includeColumnLineage = true,
        enabled = true,
    } = options

    const provider = useGraphProvider()
    const [result, setResult] = useState<LineageResult | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    const refetch = useCallback(async () => {
        if (!urn || !enabled) {
            setResult(null)
            return
        }

        setLoading(true)
        try {
            const lineage = await provider.getFullLineage(
                urn,
                upstreamDepth,
                downstreamDepth,
                includeColumnLineage
            )
            setResult(lineage)
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Failed to fetch lineage'))
        } finally {
            setLoading(false)
        }
    }, [urn, upstreamDepth, downstreamDepth, includeColumnLineage, enabled, provider])

    useEffect(() => {
        refetch()
    }, [refetch])

    return { lineage: result, loading, error, refetch }
}

/**
 * Hook for searching nodes
 */
export function useNodeSearch(query: string, limit = 10) {
    const provider = useGraphProvider()
    const [results, setResults] = useState<GraphNode[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)

    useEffect(() => {
        if (!query.trim()) {
            setResults([])
            return
        }

        let cancelled = false
        setLoading(true)

        // Debounce search
        const timer = setTimeout(() => {
            provider.searchNodes(query, limit)
                .then((nodes) => {
                    if (!cancelled) {
                        setResults(nodes)
                        setError(null)
                    }
                })
                .catch((err) => {
                    if (!cancelled) {
                        setError(err)
                    }
                })
                .finally(() => {
                    if (!cancelled) {
                        setLoading(false)
                    }
                })
        }, 200)

        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [query, limit, provider])

    return { results, loading, error }
}
