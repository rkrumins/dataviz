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
import { RemoteGraphProvider } from './RemoteGraphProvider'
import { useWorkspacesStore } from '@/store/workspaces'
import { useConnectionsStore } from '@/store/connections'
import { useCanvasStore } from '@/store/canvas'
import { useHealthStore } from '@/store/health'

// MockProvider (+ its 113 kB demo-data.ts) is loaded lazily so it never
// appears in the initial bundle. It is only fetched when the backend is
// unreachable or when a component is rendered outside a GraphProvider.
let _mockProvider: GraphDataProvider | null = null
async function ensureMockProvider(): Promise<GraphDataProvider> {
  if (!_mockProvider) {
    const { getMockProvider } = await import('./MockProvider')
    _mockProvider = getMockProvider()
  }
  return _mockProvider
}

// ============================================
// Extended context value
// ============================================

export interface GraphProviderContextValueExtended extends GraphProviderContextValue {
    workspaceId: string | null
    setWorkspaceId: (id: string | null) => void
    dataSourceId: string | null
    setDataSourceId: (id: string | null) => void
    /** True once the provider has been created AND background connectivity check has resolved (success or fail). */
    providerReady: boolean
    /** Monotonically increasing counter — increments each time a new provider instance is created. */
    providerVersion: number
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
    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)

    // Connection-based (legacy fallback)
    const activeConnectionId = useConnectionsStore((s) => s.activeConnectionId)
    const loadConnections = useConnectionsStore((s) => s.loadConnections)
    const setActiveConnection = useConnectionsStore((s) => s.setActiveConnection)

    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const [currentProvider, setCurrentProvider] = useState<GraphDataProvider | null>(null)
    const [providerReady, setProviderReady] = useState(false)
    const [providerVersion, setProviderVersion] = useState(0)

    // Track the workspace/datasource the CURRENT provider was built for.
    // This prevents a mismatch render where Zustand has updated to workspace B
    // but currentProvider still points to workspace A. By keeping these in local
    // state (updated atomically with the provider), consumers always see
    // consistent (workspaceId, provider) pairs — no stale schema fetches.
    const [providerWorkspaceId, setProviderWorkspaceId] = useState<string | null>(null)
    const [providerDataSourceId, setProviderDataSourceId] = useState<string | null>(null)

    // Track previous IDs so we only rebuild the provider when it changes
    const prevWorkspaceId = useRef<string | null | undefined>(undefined)
    const prevDataSourceId = useRef<string | null | undefined>(undefined)
    const prevConnectionId = useRef<string | null | undefined>(undefined)

    // Load both workspace and connection lists on mount
    useEffect(() => {
        loadWorkspaces()
        loadConnections()
    }, [loadWorkspaces, loadConnections])

    // Rebuild provider when workspace, data source, or connection changes
    useEffect(() => {
        if (
            prevWorkspaceId.current === activeWorkspaceId &&
            prevDataSourceId.current === activeDataSourceId &&
            prevConnectionId.current === activeConnectionId
        ) return
        prevWorkspaceId.current = activeWorkspaceId
        prevDataSourceId.current = activeDataSourceId
        prevConnectionId.current = activeConnectionId

        let cancelled = false

        // Clear canvas immediately on workspace/connection change so stale nodes
        // from the previous workspace don't linger while the new data loads.
        const { setGraph } = useCanvasStore.getState()
        setGraph([], [])

        const initProvider = async () => {
            setError(null)

            let p: RemoteGraphProvider
            if (activeWorkspaceId) {
                // Workspace-scoped: /v1/{ws_id}/graph/... with optional dataSourceId
                p = new RemoteGraphProvider({
                    workspaceId: activeWorkspaceId,
                    dataSourceId: activeDataSourceId ?? undefined,
                })
            } else if (activeConnectionId) {
                // Legacy connection-scoped: ?connectionId=xxx
                p = new RemoteGraphProvider({ connectionId: activeConnectionId })
            } else {
                // No workspace or connection → server uses primary/default
                p = new RemoteGraphProvider()
            }

            // Set the provider IMMEDIATELY — don't block on getStats().
            // This ensures navigation works instantly when switching workspaces.
            // Update providerWorkspaceId/providerDataSourceId atomically with the
            // provider so consumers never see a mismatch between IDs and provider.
            if (!cancelled) {
                setProviderReady(false)
                setCurrentProvider(p)
                setProviderWorkspaceId(activeWorkspaceId)
                setProviderDataSourceId(activeDataSourceId)
                setProviderVersion(v => v + 1)
                setIsLoading(false)
            }

            // Validate connectivity in the background — on failure, surface an error
            // but keep the provider in place (don't silently fall back to mock).
            try {
                await p.getStats()
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err : new Error('Provider connection failed'))
                    // Feed the health store for faster banner detection
                    useHealthStore.getState().reportFailure(err)
                }
            } finally {
                if (!cancelled) {
                    setProviderReady(true)
                }
            }
        }

        setIsLoading(true)
        initProvider()

        return () => { cancelled = true }
    }, [activeWorkspaceId, activeDataSourceId, activeConnectionId])

    const value: GraphProviderContextValueExtended = {
        // currentProvider is guaranteed non-null here: the early-return above handles the null+loading case.
        provider: currentProvider!,
        isLoading,
        error,
        // Use provider-tracked IDs (not Zustand's activeWorkspaceId) so
        // consumers never see a mismatch between workspace IDs and the provider.
        // Zustand may update ahead of the provider rebuild; these stay in sync.
        workspaceId: providerWorkspaceId,
        setWorkspaceId: setActiveWorkspace,
        dataSourceId: providerDataSourceId,
        setDataSourceId: setActiveDataSource,
        providerReady,
        providerVersion,
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
        // Trigger background load for next render cycle
        void ensureMockProvider()
        if (_mockProvider) return _mockProvider
        throw new Error('useGraphProvider must be used within a <GraphProvider>')
    }

    return context.provider
}

/**
 * Access the full provider context including loading/error state and workspaceId
 */
export function useGraphProviderContext(): GraphProviderContextValueExtended {
    const context = useContext(GraphProviderContext)

    if (!context) {
        void ensureMockProvider()
        if (!_mockProvider) throw new Error('useGraphProviderContext must be used within a <GraphProvider>')
        return {
            provider: _mockProvider,
            isLoading: false,
            error: null,
            workspaceId: null,
            setWorkspaceId: () => {},
            dataSourceId: null,
            setDataSourceId: () => {},
            providerReady: true,
            providerVersion: 0,
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
