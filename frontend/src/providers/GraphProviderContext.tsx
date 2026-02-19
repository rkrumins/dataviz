/**
 * GraphProviderContext - React context for graph data provider
 *
 * Workspace-aware: when an activeWorkspaceId is set in the workspaces store,
 * a new RemoteGraphProvider is created with that workspaceId so all API calls
 * are routed through /v1/{ws_id}/graph/.
 *
 * Falls back to connection-aware mode during migration, and to the primary
 * connection when neither workspace nor connection is configured.
 */

import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react'
import type { GraphDataProvider, GraphProviderContextValue } from './GraphDataProvider'
import { getMockProvider } from './MockProvider'
import { RemoteGraphProvider } from './RemoteGraphProvider'
import { useWorkspacesStore } from '@/store/workspaces'
import { useConnectionsStore } from '@/store/connections'

// ============================================
// Extended context value
// ============================================

export interface GraphProviderContextValueExtended extends GraphProviderContextValue {
    workspaceId: string | null
    setWorkspaceId: (id: string | null) => void
    /** @deprecated Use workspaceId — kept for backward compat */
    connectionId: string | null
    /** @deprecated Use setWorkspaceId — kept for backward compat */
    setConnectionId: (id: string | null) => void
}

const GraphProviderContext = createContext<GraphProviderContextValueExtended | null>(null)

// ============================================
// Provider Component
// ============================================

interface GraphProviderProps {
    children: ReactNode
}

export function GraphProvider({ children }: GraphProviderProps) {
    // Workspace-centric (primary)
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)

    // Connection-based (legacy fallback)
    const activeConnectionId = useConnectionsStore((s) => s.activeConnectionId)
    const loadConnections = useConnectionsStore((s) => s.loadConnections)
    const setActiveConnection = useConnectionsStore((s) => s.setActiveConnection)

    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [currentProvider, setCurrentProvider] = useState<GraphDataProvider | null>(null)

    // Track previous IDs so we only rebuild the provider when it changes
    const prevWorkspaceId = useRef<string | null | undefined>(undefined)
    const prevConnectionId = useRef<string | null | undefined>(undefined)

    // Load both workspace and connection lists on mount
    useEffect(() => {
        loadWorkspaces()
        loadConnections()
    }, [loadWorkspaces, loadConnections])

    // Derive the effective ID (workspace takes precedence over connection)
    const effectiveId = activeWorkspaceId || activeConnectionId

    // Rebuild provider when effectiveId changes
    useEffect(() => {
        if (
            prevWorkspaceId.current === activeWorkspaceId &&
            prevConnectionId.current === activeConnectionId
        ) return
        prevWorkspaceId.current = activeWorkspaceId
        prevConnectionId.current = activeConnectionId

        const initProvider = async () => {
            try {
                setIsLoading(true)
                setError(null)

                let p: RemoteGraphProvider
                if (activeWorkspaceId) {
                    // Workspace-scoped: /v1/{ws_id}/graph/...
                    p = new RemoteGraphProvider({ workspaceId: activeWorkspaceId })
                } else if (activeConnectionId) {
                    // Legacy connection-scoped: ?connectionId=xxx
                    p = new RemoteGraphProvider({ connectionId: activeConnectionId })
                } else {
                    // No workspace or connection → server uses primary/default
                    p = new RemoteGraphProvider()
                }

                await p.getStats()
                setCurrentProvider(p)
            } catch (err) {
                setError(err instanceof Error ? err : new Error('Failed to initialize provider'))
                setCurrentProvider(getMockProvider())
            } finally {
                setIsLoading(false)
            }
        }

        initProvider()
    }, [activeWorkspaceId, activeConnectionId])

    if (!currentProvider && isLoading) {
        return null
    }

    const value: GraphProviderContextValueExtended = {
        provider: currentProvider ?? getMockProvider(),
        isLoading,
        error,
        workspaceId: activeWorkspaceId,
        setWorkspaceId: setActiveWorkspace,
        connectionId: activeConnectionId,
        setConnectionId: setActiveConnection,
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
        console.warn('useGraphProvider: No GraphProvider found, using MockProvider')
        return getMockProvider()
    }

    return context.provider
}

/**
 * Access the full provider context including loading/error state and workspaceId
 */
export function useGraphProviderContext(): GraphProviderContextValueExtended {
    const context = useContext(GraphProviderContext)

    if (!context) {
        return {
            provider: getMockProvider(),
            isLoading: false,
            error: null,
            workspaceId: null,
            setWorkspaceId: () => {},
            connectionId: null,
            setConnectionId: () => {},
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
