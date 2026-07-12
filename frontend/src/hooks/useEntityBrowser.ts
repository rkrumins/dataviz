/**
 * useEntityBrowser — API-authoritative entity browsing hook for the ViewWizard.
 *
 * Loads entities that sit at the TOP of the containment hierarchy (ontology
 * roots + orphan instances of non-root types), then lazy-expands children
 * via containment edges. Every browse action hits the API — no stale caches.
 *
 * Why "top-level" and not "root types":
 *   The old implementation derived a list of "root entity types" from the
 *   ontology and then queried `getNodes({ entityTypes: rootTypes })`. That
 *   was both ontology-specific (custom ontologies may have no single root)
 *   AND silently ignored orphans — a Platform ingested without a Domain
 *   would just disappear from the wizard. The new `getTopLevelNodes`
 *   endpoint is a *structural* query: "nodes with no incoming containment
 *   edge", which makes the wizard correct on any ontology and surfaces
 *   orphans explicitly (diagnostic `rootTypeCount` / `orphanCount` fields).
 *
 * Designed for million-node scale:
 * - Cursor-based pagination for both top-level AND child loads
 * - Strictly lazy: ONE level per expand, never recursive
 * - Type filter is pure frontend ontology computation (no API call) when
 *   filtering what the user sees; when the filter is active AND no search
 *   is running, we re-query with `entityTypes=[typeId]` so the top-level
 *   page is pre-narrowed by the server instead of fetching N pages and
 *   filtering them down client-side.
 * - Scoped search within expanded subtrees via `/nodes/top-level?searchQuery`
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import type {
    GraphDataProvider,
    GraphNode,
    EntityTypeDefinition,
} from '@/providers/GraphDataProvider'

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

/** Bulk "load all" paging. The children endpoints have no route-level max
 *  (graph.py children limit is only `ge=1`), so 500/page keeps payloads sane;
 *  top-level IS capped at `le=1000` server-side. */
const BULK_CHILD_PAGE_SIZE = 500
const BULK_TOP_LEVEL_PAGE_SIZE = 1000
/** Hard safety stop for "load all" loops (200 × 500 = 100k children/node). */
const BULK_MAX_PAGES = 200

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserNode {
    /** Raw API response — always authoritative */
    node: GraphNode
    /** URNs of direct children (from containment edges in the API response) */
    childIds: string[]
    /**
     * Best-known number of children.
     *
     * CAREFUL: a paged children response's `totalChildren` is NOT a count —
     * every provider computes it as `offset + len(page) + (1 if has_more)`
     * (see common/interfaces/provider.py, falkordb_provider.py), i.e. a paging
     * heuristic that reads 51 for a node with 200 children. The node's own
     * `childCount` IS a real count query. So this field is derived from
     * `node.childCount` when we have it, and NEVER downgraded by a page load.
     */
    totalChildren: number
    /** True when `totalChildren` is a real count (not a floor we inferred). */
    totalIsExact: boolean
    /** Whether more children exist beyond what's loaded */
    hasMore: boolean
    /** Cursor for the next page of children */
    nextCursor: string | null
    /** Whether children have been fetched at least once */
    loaded: boolean
}

/**
 * Resolve the honest child total for a node.
 *
 * `node.childCount` is authoritative (a server-side count). Otherwise we only
 * know a floor: what we've actually loaded — exact only once the last page is in.
 */
function resolveChildTotal(
    node: GraphNode,
    loadedCount: number,
    hasMore: boolean,
    prev?: BrowserNode,
): { totalChildren: number; totalIsExact: boolean } {
    const authoritative = node.childCount
    if (typeof authoritative === 'number' && authoritative > 0) {
        return { totalChildren: authoritative, totalIsExact: true }
    }
    // No count from the server: the most we can honestly claim is what we hold.
    const floor = Math.max(loadedCount, prev?.totalIsExact ? prev.totalChildren : 0)
    return { totalChildren: floor, totalIsExact: !hasMore && loadedCount > 0 }
}

export interface TopLevelMetadata {
    /** How many top-level nodes are ontology-root instances. */
    rootTypeCount: number
    /** How many are orphans of non-root types (missing containment in-edge). */
    orphanCount: number
}

export interface UseEntityBrowserOptions {
    provider: GraphDataProvider
    /** Containment edge types from the ontology (is_containment=true).
     *  Still required for child-expansion calls. */
    containmentEdgeTypes: string[]
    /**
     * Full entity type definitions from the ontology — kept ONLY so the
     * type-filter UI can compute `canContain` chains and show/hide
     * intermediate branches in the tree. NOT used for data loading.
     */
    entityTypeDefinitions: EntityTypeDefinition[]
    /** Set to false while schema is still loading. */
    enabled: boolean
}

export interface UseEntityBrowserResult {
    // ─── Data (from API responses) ───
    nodes: Map<string, BrowserNode>
    topLevelIds: string[]
    topLevelHasMore: boolean
    topLevelTotalCount: number
    topLevelMetadata: TopLevelMetadata
    parentMap: Map<string, string>
    /** Fresh read of a node entry (ref-backed) — safe to call after an awaited
     *  action inside the same callback, where the `nodes` state would be stale. */
    peekNode: (urn: string) => BrowserNode | undefined

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
    loadTopLevel: () => Promise<void>
    loadMoreTopLevel: () => Promise<void>
    expandNode: (urn: string) => Promise<void>
    loadMoreChildren: (parentUrn: string) => Promise<void>
    /**
     * Page through ALL remaining children of a node (500/page) until exhausted,
     * and RETURN the complete child list. The return value matters: React state
     * is not yet updated when this resolves, so callers must use what they get
     * back (or `peekNode`) rather than re-reading `nodes`.
     */
    loadAllChildren: (parentUrn: string) => Promise<string[]>
    /** Page through ALL remaining top-level nodes (1000/page) until exhausted. */
    loadAllTopLevel: () => Promise<void>
    setSearch: (query: string) => void
    setTypeFilter: (typeId: string | null) => void
    refresh: () => Promise<void>
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useEntityBrowser(options: UseEntityBrowserOptions): UseEntityBrowserResult {
    const { provider, containmentEdgeTypes, entityTypeDefinitions, enabled } = options

    // ─── State ───
    const [nodes, setNodes] = useState<Map<string, BrowserNode>>(new Map())
    const [topLevelIds, setTopLevelIds] = useState<string[]>([])
    const [topLevelHasMore, setTopLevelHasMore] = useState(false)
    const [topLevelCursor, setTopLevelCursor] = useState<string | null>(null)
    const [topLevelTotalCount, setTopLevelTotalCount] = useState(0)
    const [topLevelMetadata, setTopLevelMetadata] = useState<TopLevelMetadata>({
        rootTypeCount: 0,
        orphanCount: 0,
    })
    const [parentMap, setParentMap] = useState<Map<string, string>>(new Map())
    const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [searchQuery, setSearchQueryState] = useState('')
    const [typeFilter, setTypeFilterState] = useState<string | null>(null)

    // Refs — mutable, no re-render, no stale closure issues
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const providerRef = useRef<GraphDataProvider | null>(null)

    // ── The node map is REF-first, state-second ───────────────────────────────
    // Callers do `await loadAllChildren(urn)` and then immediately read the
    // result. React's automatic batching means `nodes` (and a ref synced during
    // render) is still the PRE-load map at that moment — which is why "Select
    // all N children" used to do nothing on the first click and work on the
    // second. So the ref is the source of truth, updated synchronously on every
    // write, and `setNodes` only mirrors it for rendering.
    const nodesRef = useRef<Map<string, BrowserNode>>(nodes)
    const commitNodes = useCallback(
        (mutate: (prev: Map<string, BrowserNode>) => Map<string, BrowserNode>) => {
            const next = mutate(nodesRef.current)
            nodesRef.current = next
            setNodes(next)
        },
        [],
    )

    // Same rule for the top-level page state the bulk loaders read after awaits.
    const topLevelIdsRef = useRef<string[]>(topLevelIds)
    const topLevelCursorRef = useRef<string | null>(topLevelCursor)
    const topLevelHasMoreRef = useRef<boolean>(topLevelHasMore)
    const parentMapRef = useRef<Map<string, string>>(parentMap)

    // Capture current filter/search inside loaders without retriggering the
    // callback identity every time the user types — the callback reads the
    // ref at call-time instead.
    const typeFilterRef = useRef(typeFilter)
    typeFilterRef.current = typeFilter
    // Guards so concurrent "load all" loops never run twice for the same target.
    const bulkInFlightRef = useRef<Set<string>>(new Set())

    const commitParentMap = useCallback((edges: { sourceUrn: string; targetUrn: string }[]) => {
        if (edges.length === 0) return
        const next = new Map(parentMapRef.current)
        for (const edge of edges) next.set(edge.targetUrn, edge.sourceUrn)
        parentMapRef.current = next
        setParentMap(next)
    }, [])

    // Reset when provider changes (workspace/datasource switch)
    useEffect(() => {
        if (providerRef.current !== provider) {
            providerRef.current = provider
            nodesRef.current = new Map()
            topLevelIdsRef.current = []
            topLevelCursorRef.current = null
            topLevelHasMoreRef.current = false
            parentMapRef.current = new Map()
            bulkInFlightRef.current = new Set()
            setNodes(new Map())
            setTopLevelIds([])
            setTopLevelHasMore(false)
            setTopLevelCursor(null)
            setTopLevelTotalCount(0)
            setTopLevelMetadata({ rootTypeCount: 0, orphanCount: 0 })
            setParentMap(new Map())
            setError(null)
        }
    }, [provider])

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

    /** A freshly-seen node, with its child total taken from the authoritative count. */
    const freshEntry = useCallback((node: GraphNode, prev?: BrowserNode): BrowserNode => ({
        node,
        childIds: prev?.childIds ?? [],
        ...resolveChildTotal(node, prev?.childIds.length ?? 0, prev?.hasMore ?? false, prev),
        hasMore: prev?.hasMore ?? false,
        nextCursor: prev?.nextCursor ?? null,
        loaded: prev?.loaded ?? false,
    }), [])

    const mergeTopLevelResult = useCallback(
        (
            result: Awaited<ReturnType<GraphDataProvider['getTopLevelNodes']>>,
            mode: 'replace' | 'append',
        ) => {
            if (mode === 'replace') {
                const newNodes = new Map<string, BrowserNode>()
                const newIds: string[] = []
                for (const node of result.nodes) {
                    newNodes.set(node.urn, freshEntry(node))
                    newIds.push(node.urn)
                }
                nodesRef.current = newNodes
                topLevelIdsRef.current = newIds
                parentMapRef.current = new Map()
                setNodes(newNodes)
                setTopLevelIds(newIds)
                setParentMap(new Map())
            } else {
                commitNodes(prev => {
                    const next = new Map(prev)
                    for (const node of result.nodes) {
                        if (!next.has(node.urn)) next.set(node.urn, freshEntry(node))
                    }
                    return next
                })
                const existing = new Set(topLevelIdsRef.current)
                const appended = result.nodes
                    .filter(n => !existing.has(n.urn))
                    .map(n => n.urn)
                const nextIds = [...topLevelIdsRef.current, ...appended]
                topLevelIdsRef.current = nextIds
                setTopLevelIds(nextIds)
            }
            topLevelHasMoreRef.current = Boolean(result.hasMore)
            topLevelCursorRef.current = result.nextCursor ?? null
            setTopLevelHasMore(Boolean(result.hasMore))
            setTopLevelCursor(result.nextCursor ?? null)
            setTopLevelTotalCount(result.totalCount ?? 0)
            setTopLevelMetadata({
                rootTypeCount: result.rootTypeCount ?? 0,
                orphanCount: result.orphanCount ?? 0,
            })
        },
        [commitNodes, freshEntry],
    )

    /**
     * Fold one page of children into the parent entry.
     *
     * The parent's `totalChildren` is NEVER taken from `result.totalChildren`
     * (a paging heuristic — see BrowserNode). It stays anchored to the node's
     * own count; only when the server never gave us one do we fall back to the
     * honest floor of what we've loaded.
     */
    const mergeChildrenPage = useCallback(
        (
            parentUrn: string,
            result: Awaited<ReturnType<GraphDataProvider['getChildrenWithEdges']>>,
            mode: 'replace' | 'append',
        ): string[] => {
            let childIdsAfter: string[] = []

            commitNodes(prev => {
                const next = new Map(prev)

                for (const child of result.children) {
                    next.set(child.urn, freshEntry(child, next.get(child.urn)))
                }

                const parent = next.get(parentUrn)
                if (parent) {
                    const pageIds = result.children.map(c => c.urn)
                    const merged = mode === 'replace'
                        ? pageIds
                        : [...parent.childIds, ...pageIds.filter(id => !new Set(parent.childIds).has(id))]
                    childIdsAfter = merged

                    next.set(parentUrn, {
                        ...parent,
                        childIds: merged,
                        ...resolveChildTotal(parent.node, merged.length, Boolean(result.hasMore), parent),
                        hasMore: Boolean(result.hasMore),
                        nextCursor: result.nextCursor ?? null,
                        loaded: true,
                    })
                }
                return next
            })

            commitParentMap(result.containmentEdges)
            return childIdsAfter
        },
        [commitNodes, commitParentMap, freshEntry],
    )

    // ─── loadTopLevel ───

    const loadTopLevel = useCallback(async () => {
        if (!enabled) return

        setIsLoading(true)
        setError(null)

        try {
            const activeFilter = typeFilterRef.current
            const result = await provider.getTopLevelNodes({
                entityTypes: activeFilter ? [activeFilter] : undefined,
                limit: PAGE_SIZE,
                cursor: null,
                includeChildCount: true,
            })
            mergeTopLevelResult(result, 'replace')
        } catch (err) {
            console.error('[useEntityBrowser] Failed to load top-level nodes:', err)
            setError(err instanceof Error ? err.message : 'Failed to load entities')
        } finally {
            setIsLoading(false)
        }
    }, [enabled, provider, mergeTopLevelResult])

    // ─── loadMoreTopLevel ───

    const loadMoreTopLevel = useCallback(async () => {
        if (!topLevelHasMore) return
        addLoading('__top-level')

        try {
            const activeFilter = typeFilterRef.current
            const result = await provider.getTopLevelNodes({
                entityTypes: activeFilter ? [activeFilter] : undefined,
                limit: PAGE_SIZE,
                cursor: topLevelCursor,
                includeChildCount: true,
            })
            mergeTopLevelResult(result, 'append')
        } catch (err) {
            console.error('[useEntityBrowser] Failed to load more top-level nodes:', err)
        } finally {
            removeLoading('__top-level')
        }
    }, [topLevelHasMore, topLevelCursor, provider, mergeTopLevelResult, addLoading, removeLoading])

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
            mergeChildrenPage(urn, result, 'replace')
        } catch (err) {
            console.error(`[useEntityBrowser] Failed to expand ${urn}:`, err)
        } finally {
            removeLoading(urn)
        }
    }, [provider, containmentEdgeTypes, mergeChildrenPage, addLoading, removeLoading])
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
            mergeChildrenPage(parentUrn, result, 'append')
        } catch (err) {
            console.error(`[useEntityBrowser] Failed to load more children for ${parentUrn}:`, err)
        } finally {
            removeLoading(parentUrn)
        }
    }, [provider, containmentEdgeTypes, mergeChildrenPage, addLoading, removeLoading])

    // ─── loadAllChildren: page through EVERY remaining child of a node ───
    // Resumes from the current cursor when children are partially loaded, so
    // work already done by expand/load-more is never re-fetched. Cursor state
    // is tracked locally from API results (React state is stale inside the loop).

    const loadAllChildren = useCallback(async (parentUrn: string): Promise<string[]> => {
        const alreadyComplete = (urn: string) => {
            const e = nodesRef.current.get(urn)
            return !!e?.loaded && !e.hasMore
        }
        if (bulkInFlightRef.current.has(parentUrn)) return nodesRef.current.get(parentUrn)?.childIds ?? []
        if (alreadyComplete(parentUrn)) return nodesRef.current.get(parentUrn)?.childIds ?? []

        bulkInFlightRef.current.add(parentUrn)
        addLoading(parentUrn)

        try {
            const first = nodesRef.current.get(parentUrn)
            // Resume from where paging left off rather than re-fetching page 1.
            let cursor: string | null = first?.loaded ? (first.nextCursor ?? null) : null
            let mode: 'replace' | 'append' = first?.loaded ? 'append' : 'replace'
            let childIds: string[] = first?.childIds ?? []

            for (let page = 0; page < BULK_MAX_PAGES; page++) {
                const result = await provider.getChildrenWithEdges(parentUrn, {
                    edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                    limit: BULK_CHILD_PAGE_SIZE,
                    ...(cursor ? { cursor } : { offset: 0 }),
                    includeLineageEdges: false,
                })

                // Returns the merged child list — the caller must never have to
                // re-read React state to find out what it just loaded.
                childIds = mergeChildrenPage(parentUrn, result, mode)
                mode = 'append'

                if (!result.hasMore) break
                cursor = result.nextCursor ?? null
                if (!cursor) break // defensive: server claims more but gave no cursor
            }

            return childIds
        } catch (err) {
            console.error(`[useEntityBrowser] Failed to load all children for ${parentUrn}:`, err)
            return nodesRef.current.get(parentUrn)?.childIds ?? []
        } finally {
            bulkInFlightRef.current.delete(parentUrn)
            removeLoading(parentUrn)
        }
    }, [provider, containmentEdgeTypes, mergeChildrenPage, addLoading, removeLoading])

    // ─── loadAllTopLevel: page through EVERY remaining top-level node ───
    // Mirrors loadMoreTopLevel's context (current type filter, no search param —
    // same as the existing load-more path) and appends until exhausted.

    const loadAllTopLevel = useCallback(async () => {
        if (!topLevelHasMoreRef.current) return
        if (bulkInFlightRef.current.has('__top-level')) return

        bulkInFlightRef.current.add('__top-level')
        addLoading('__top-level')

        try {
            let cursor = topLevelCursorRef.current
            for (let page = 0; page < BULK_MAX_PAGES; page++) {
                const activeFilter = typeFilterRef.current
                const result = await provider.getTopLevelNodes({
                    entityTypes: activeFilter ? [activeFilter] : undefined,
                    limit: BULK_TOP_LEVEL_PAGE_SIZE,
                    cursor,
                    includeChildCount: true,
                })
                mergeTopLevelResult(result, 'append')

                if (!result.hasMore) break
                cursor = result.nextCursor ?? null
                if (!cursor) break
            }
        } catch (err) {
            console.error('[useEntityBrowser] Failed to load all top-level nodes:', err)
        } finally {
            bulkInFlightRef.current.delete('__top-level')
            removeLoading('__top-level')
        }
    }, [provider, mergeTopLevelResult, addLoading, removeLoading])

    // ─── peekNode: ref-backed fresh read ───

    const peekNode = useCallback((urn: string) => nodesRef.current.get(urn), [])

    // ─── setSearch: debounced server-side search ───

    const setSearch = useCallback((query: string) => {
        setSearchQueryState(query)

        if (searchTimerRef.current) {
            clearTimeout(searchTimerRef.current)
        }

        if (!query.trim()) {
            loadTopLevel()
            return
        }

        searchTimerRef.current = setTimeout(async () => {
            setIsLoading(true)
            try {
                const activeFilter = typeFilterRef.current
                const result = await provider.getTopLevelNodes({
                    entityTypes: activeFilter ? [activeFilter] : undefined,
                    searchQuery: query,
                    limit: PAGE_SIZE,
                    cursor: null,
                    includeChildCount: true,
                })
                mergeTopLevelResult(result, 'replace')
            } catch (err) {
                console.error('[useEntityBrowser] Search failed:', err)
                setError(err instanceof Error ? err.message : 'Search failed')
            } finally {
                setIsLoading(false)
            }
        }, 300)
    }, [provider, mergeTopLevelResult, loadTopLevel])

    // ─── setTypeFilter ───

    const setTypeFilter = useCallback((typeId: string | null) => {
        setTypeFilterState(typeId)
        // Re-query top-level with the new filter. If the user has an active
        // search, preserve it; otherwise fall through to a plain top-level
        // refresh. Update the ref immediately so the async callbacks see the
        // new filter without waiting for the next render.
        typeFilterRef.current = typeId
        if (searchQuery.trim()) {
            setSearch(searchQuery)
        } else {
            loadTopLevel()
        }
    }, [searchQuery, setSearch, loadTopLevel])

    // ─── refresh ───

    const refresh = useCallback(async () => {
        if (searchQuery.trim()) {
            setSearch(searchQuery)
        } else {
            await loadTopLevel()
        }
    }, [searchQuery, setSearch, loadTopLevel])

    // Cleanup
    useEffect(() => {
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
        }
    }, [])

    return {
        nodes,
        topLevelIds,
        topLevelHasMore,
        topLevelTotalCount,
        topLevelMetadata,
        parentMap,
        peekNode,
        canTransitivelyContain,
        typesOnPathTo,
        isLoading,
        loadingNodes,
        searchQuery,
        typeFilter,
        error,
        loadTopLevel,
        loadMoreTopLevel,
        expandNode,
        loadMoreChildren,
        loadAllChildren,
        loadAllTopLevel,
        setSearch,
        setTypeFilter,
        refresh,
    }
}
