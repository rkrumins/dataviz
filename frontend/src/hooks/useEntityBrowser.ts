/**
 * useEntityBrowser - API-authoritative entity browsing hook for the ViewWizard.
 *
 * Loads entities hierarchically per the ontology: root types first, lazy-expand
 * children via containment edges, hierarchy-preserving type filter, server-side
 * search. Every browse action hits the API — no stale caches.
 *
 * Designed for million-node scale:
 * - Cursor-based pagination (O(log N) via GET /children-with-edges?cursor=)
 * - Strictly lazy: ONE level per expand, never recursive
 * - Type filter is pure frontend ontology computation (no API call)
 * - Scoped search within expanded subtrees
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import type {
    GraphDataProvider,
    GraphNode,
    EntityTypeDefinition,
} from '@/providers/GraphDataProvider'

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserNode {
    /** Raw API response — always authoritative */
    node: GraphNode
    /** URNs of direct children (from containment edges in the API response) */
    childIds: string[]
    /** Approximate total children count (from API childCount or totalChildren) */
    totalChildren: number
    /** Whether more children exist beyond what's loaded */
    hasMore: boolean
    /** Cursor for the next page of children */
    nextCursor: string | null
    /** Whether children have been fetched at least once */
    loaded: boolean
}

export interface UseEntityBrowserOptions {
    provider: GraphDataProvider
    /** Root entity types from the ontology (types with no canBeContainedBy) */
    rootEntityTypes: string[]
    /** Containment edge types from the ontology (is_containment=true) */
    containmentEdgeTypes: string[]
    /** Full entity type definitions from the ontology (for canContain chains) */
    entityTypeDefinitions: EntityTypeDefinition[]
    /** Set to false while schema is still loading */
    enabled: boolean
}

export interface UseEntityBrowserResult {
    // ─── Data (from API responses) ───
    nodes: Map<string, BrowserNode>
    rootIds: string[]
    rootHasMore: boolean
    parentMap: Map<string, string>

    // ─── Ontology-derived ───
    canTransitivelyContain: (ancestorType: string, targetType: string) => boolean
    typesOnPathTo: (targetType: string) => Set<string>

    // ─── State ───
    isLoading: boolean
    loadingNodes: Set<string>
    searchQuery: string
    typeFilter: string | null
    error: string | null

    // ─── Actions ───
    loadRoots: () => Promise<void>
    loadMoreRoots: () => Promise<void>
    expandNode: (urn: string) => Promise<void>
    loadMoreChildren: (parentUrn: string) => Promise<void>
    setSearch: (query: string) => void
    setTypeFilter: (typeId: string | null) => void
    refresh: () => Promise<void>
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useEntityBrowser(options: UseEntityBrowserOptions): UseEntityBrowserResult {
    const { provider, rootEntityTypes, containmentEdgeTypes, entityTypeDefinitions, enabled } = options

    // ─── State ───
    const [nodes, setNodes] = useState<Map<string, BrowserNode>>(new Map())
    const [rootIds, setRootIds] = useState<string[]>([])
    const [rootHasMore, setRootHasMore] = useState(false)
    const [parentMap, setParentMap] = useState<Map<string, string>>(new Map())
    const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [searchQuery, setSearchQueryState] = useState('')
    const [typeFilter, setTypeFilterState] = useState<string | null>(null)

    // Refs — mutable, no re-render, no stale closure issues
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const providerRef = useRef<GraphDataProvider | null>(null)
    // Use refs for state that callbacks need to read without re-creating closures
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes

    // Reset when provider changes (workspace/datasource switch)
    useEffect(() => {
        if (providerRef.current !== provider) {
            providerRef.current = provider
            setNodes(new Map())
            setRootIds([])
            setRootHasMore(false)
            setParentMap(new Map())
            setError(null)
        }
    }, [provider])

    // ─── Compute root types to load (memoized) ───
    const effectiveRootTypes = useMemo(() => {
        if (rootEntityTypes.length > 0) return rootEntityTypes
        // Compute from ontology: types with no canBeContainedBy parents
        const computed = entityTypeDefinitions
            .filter(et => !et.hierarchy?.canBeContainedBy?.length)
            .map(et => et.id)
        return computed.length > 0 ? computed : entityTypeDefinitions.map(et => et.id)
    }, [rootEntityTypes, entityTypeDefinitions])

    // ─── Ontology computations (memoized, zero API calls) ───

    const canContainMap = useMemo(() => {
        const map = new Map<string, string[]>()
        for (const et of entityTypeDefinitions) {
            map.set(et.id, et.hierarchy?.canContain ?? [])
        }
        return map
    }, [entityTypeDefinitions])

    const canTransitivelyContain = useCallback((ancestorType: string, targetType: string): boolean => {
        if (ancestorType === targetType) return true
        const visited = new Set<string>()
        const queue = [ancestorType]
        while (queue.length > 0) {
            const current = queue.shift()!
            if (visited.has(current)) continue
            visited.add(current)
            const children = canContainMap.get(current) ?? []
            for (const child of children) {
                if (child === targetType) return true
                queue.push(child)
            }
        }
        return false
    }, [canContainMap])

    const typesOnPathTo = useCallback((targetType: string): Set<string> => {
        const result = new Set<string>()
        for (const et of entityTypeDefinitions) {
            if (et.id === targetType) continue
            if (canTransitivelyContain(et.id, targetType)) {
                result.add(et.id)
            }
        }
        return result
    }, [entityTypeDefinitions, canTransitivelyContain])

    // ─── Helpers ───

    const addLoading = useCallback((id: string) => {
        setLoadingNodes(prev => { const next = new Set(prev); next.add(id); return next })
    }, [])

    const removeLoading = useCallback((id: string) => {
        setLoadingNodes(prev => { const next = new Set(prev); next.delete(id); return next })
    }, [])

    // ─── loadRoots ───

    const loadRoots = useCallback(async () => {
        if (!enabled || effectiveRootTypes.length === 0) return

        setIsLoading(true)
        setError(null)

        try {
            const result = await provider.getNodes({
                entityTypes: effectiveRootTypes,
                limit: PAGE_SIZE,
                offset: 0,
            })

            const newNodes = new Map<string, BrowserNode>()
            const newRootIds: string[] = []

            for (const node of result) {
                newNodes.set(node.urn, {
                    node,
                    childIds: [],
                    totalChildren: node.childCount ?? 0,
                    hasMore: false,
                    nextCursor: null,
                    loaded: false,
                })
                newRootIds.push(node.urn)
            }

            setNodes(newNodes)
            setRootIds(newRootIds)
            setRootHasMore(result.length >= PAGE_SIZE)
            setParentMap(new Map())
        } catch (err) {
            console.error('[useEntityBrowser] Failed to load roots:', err)
            setError(err instanceof Error ? err.message : 'Failed to load root entities')
        } finally {
            setIsLoading(false)
        }
    }, [enabled, provider, effectiveRootTypes])

    // ─── loadMoreRoots ───

    const loadMoreRoots = useCallback(async () => {
        if (!rootHasMore) return
        addLoading('__roots')

        try {
            const result = await provider.getNodes({
                entityTypes: effectiveRootTypes,
                limit: PAGE_SIZE,
                offset: rootIds.length,
            })

            setNodes(prev => {
                const next = new Map(prev)
                for (const node of result) {
                    if (!next.has(node.urn)) {
                        next.set(node.urn, {
                            node,
                            childIds: [],
                            totalChildren: node.childCount ?? 0,
                            hasMore: false,
                            nextCursor: null,
                            loaded: false,
                        })
                    }
                }
                return next
            })
            setRootIds(prev => {
                const existing = new Set(prev)
                const newIds = result.filter(n => !existing.has(n.urn)).map(n => n.urn)
                return [...prev, ...newIds]
            })
            setRootHasMore(result.length >= PAGE_SIZE)
        } catch (err) {
            console.error('[useEntityBrowser] Failed to load more roots:', err)
        } finally {
            removeLoading('__roots')
        }
    }, [rootHasMore, provider, effectiveRootTypes, rootIds.length, addLoading, removeLoading])

    // ─── expandNode: lazy-load direct children (ONE level only) ───
    // Uses nodesRef to avoid re-creating this callback when nodes change.

    const expandNode = useCallback(async (urn: string) => {
        // Read from ref to avoid stale closure — no nodes in dependency array
        const existing = nodesRef.current.get(urn)
        if (existing?.loaded) return

        addLoading(urn)

        try {
            const result = await provider.getChildrenWithEdges(urn, {
                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                limit: PAGE_SIZE,
                offset: 0,
                includeLineageEdges: false,
            })

            setNodes(prev => {
                const next = new Map(prev)

                // Collect child IDs inside the updater to avoid closure issues
                const childIds: string[] = []
                for (const child of result.children) {
                    childIds.push(child.urn)
                    // Always update the child node data (fresh from API)
                    const existingChild = next.get(child.urn)
                    next.set(child.urn, {
                        node: child,
                        childIds: existingChild?.childIds ?? [],
                        totalChildren: child.childCount ?? 0,
                        hasMore: existingChild?.hasMore ?? false,
                        nextCursor: existingChild?.nextCursor ?? null,
                        loaded: existingChild?.loaded ?? false,
                    })
                }

                // Update parent with children info
                const parentEntry = next.get(urn)
                if (parentEntry) {
                    next.set(urn, {
                        ...parentEntry,
                        childIds,
                        totalChildren: result.totalChildren,
                        hasMore: result.hasMore,
                        nextCursor: result.nextCursor ?? null,
                        loaded: true,
                    })
                }
                return next
            })

            // Update parent map from containment edges
            setParentMap(prev => {
                const next = new Map(prev)
                for (const edge of result.containmentEdges) {
                    next.set(edge.targetUrn, edge.sourceUrn)
                }
                return next
            })
        } catch (err) {
            console.error(`[useEntityBrowser] Failed to expand ${urn}:`, err)
        } finally {
            removeLoading(urn)
        }
    }, [provider, containmentEdgeTypes, addLoading, removeLoading])
    // NOTE: no `nodes` in deps — uses nodesRef instead to prevent infinite re-creation

    // ─── loadMoreChildren ───

    const loadMoreChildren = useCallback(async (parentUrn: string) => {
        const parentEntry = nodesRef.current.get(parentUrn)
        if (!parentEntry?.hasMore) return

        addLoading(parentUrn)

        try {
            const result = await provider.getChildrenWithEdges(parentUrn, {
                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                limit: PAGE_SIZE,
                cursor: parentEntry.nextCursor,
                includeLineageEdges: false,
            })

            setNodes(prev => {
                const next = new Map(prev)
                const newChildIds: string[] = []

                for (const child of result.children) {
                    newChildIds.push(child.urn)
                    if (!next.has(child.urn)) {
                        next.set(child.urn, {
                            node: child,
                            childIds: [],
                            totalChildren: child.childCount ?? 0,
                            hasMore: false,
                            nextCursor: null,
                            loaded: false,
                        })
                    }
                }

                const entry = next.get(parentUrn)
                if (entry) {
                    const existingSet = new Set(entry.childIds)
                    const appendIds = newChildIds.filter(id => !existingSet.has(id))
                    next.set(parentUrn, {
                        ...entry,
                        childIds: [...entry.childIds, ...appendIds],
                        totalChildren: result.totalChildren,
                        hasMore: result.hasMore,
                        nextCursor: result.nextCursor ?? null,
                    })
                }
                return next
            })

            setParentMap(prev => {
                const next = new Map(prev)
                for (const edge of result.containmentEdges) {
                    next.set(edge.targetUrn, edge.sourceUrn)
                }
                return next
            })
        } catch (err) {
            console.error(`[useEntityBrowser] Failed to load more children for ${parentUrn}:`, err)
        } finally {
            removeLoading(parentUrn)
        }
    }, [provider, containmentEdgeTypes, addLoading, removeLoading])

    // ─── setSearch: debounced server-side search ───

    const setSearch = useCallback((query: string) => {
        setSearchQueryState(query)

        if (searchTimerRef.current) {
            clearTimeout(searchTimerRef.current)
        }

        if (!query.trim()) {
            loadRoots()
            return
        }

        searchTimerRef.current = setTimeout(async () => {
            setIsLoading(true)
            try {
                const searchEntityTypes = typeFilter ? [typeFilter] : undefined
                const result = await provider.getNodes({
                    searchQuery: query,
                    entityTypes: searchEntityTypes,
                    limit: PAGE_SIZE,
                    offset: 0,
                })

                const newNodes = new Map<string, BrowserNode>()
                const newRootIds: string[] = []

                for (const node of result) {
                    newNodes.set(node.urn, {
                        node,
                        childIds: [],
                        totalChildren: node.childCount ?? 0,
                        hasMore: false,
                        nextCursor: null,
                        loaded: false,
                    })
                    newRootIds.push(node.urn)
                }

                setNodes(newNodes)
                setRootIds(newRootIds)
                setRootHasMore(result.length >= PAGE_SIZE)
                setParentMap(new Map())
            } catch (err) {
                console.error('[useEntityBrowser] Search failed:', err)
            } finally {
                setIsLoading(false)
            }
        }, 300)
    }, [provider, typeFilter, loadRoots])

    // ─── setTypeFilter ───

    const setTypeFilter = useCallback((typeId: string | null) => {
        setTypeFilterState(typeId)
        if (searchQuery.trim()) {
            setSearch(searchQuery)
        }
    }, [searchQuery, setSearch])

    // ─── refresh ───

    const refresh = useCallback(async () => {
        if (searchQuery.trim()) {
            setSearch(searchQuery)
        } else {
            await loadRoots()
        }
    }, [searchQuery, setSearch, loadRoots])

    // Cleanup
    useEffect(() => {
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
        }
    }, [])

    return {
        nodes,
        rootIds,
        rootHasMore,
        parentMap,
        canTransitivelyContain,
        typesOnPathTo,
        isLoading,
        loadingNodes,
        searchQuery,
        typeFilter,
        error,
        loadRoots,
        loadMoreRoots,
        expandNode,
        loadMoreChildren,
        setSearch,
        setTypeFilter,
        refresh,
    }
}
