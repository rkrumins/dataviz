/**
 * useLensChildren — "show me everything inside this entity", server-paged.
 *
 * Keyed directly by the entity's own urn: there is no openKey/anchor
 * indirection to resolve, because there is no pass-through walk to land
 * somewhere else first. (This is the surviving half of the retired
 * useLensContainer — its roster/paging/Find machinery; the pairwise
 * open-against-a-focal concept died with the walk model, which knows
 * the participants without asking.)
 *
 * Deliberately a separate fetch from the walk model: the server has no way
 * to ask "children of X, flagged by whether they're on the lineage walk",
 * so the walk model is the truth about lineage-participating leaves and
 * this is the truth about membership — "what's really in here", connected
 * or not.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import { CHILDREN_PAGE_SIZE } from '@/config/pagination'

type LensChildNode = ReturnType<typeof toCanvasNode>

export type LensChildrenStatus = 'loading' | 'done' | 'error' | 'unsupported'

/** One entity's children, accumulated across pages. */
export interface LensChildrenResult {
    /** Children in the server's own order, accumulated across pages. */
    children: LensChildNode[]
    /** More pages exist on the server. */
    hasMore: boolean
    /** Authoritative count once fully drained; null while still paging or
     *  searching — never a fabricated total. */
    total: number | null
    /** The search this page set answers ('' for the unfiltered list). A
     *  new query is a new question: pages reset rather than appending. */
    query?: string
}

export interface LensChildrenData {
    /** Every fetched entity's children, keyed by its own urn. */
    allResults: Map<string, LensChildrenResult>
    allStatus: Map<string, LensChildrenStatus>
    /** Fetch (or page further into, or search within) one entity's
     *  children. */
    loadAllChildren: (urn: string, searchQuery?: string) => void
    /** Fetch (or page further into) one entity's children, unfiltered. */
    loadChildrenOf: (urn: string) => void
}

interface ChildrenState {
    allResults: Map<string, LensChildrenResult>
    allStatus: Map<string, LensChildrenStatus>
}

const emptyState = (): ChildrenState => ({ allResults: new Map(), allStatus: new Map() })

function setIn<V>(m: Map<string, V>, key: string, value: V): Map<string, V> {
    const next = new Map(m)
    next.set(key, value)
    return next
}

export function useLensChildren(
    /** Current focal, or null when the lens is closed (clears the session).
     *  Only a lifecycle signal — results are NOT bucketed by it, because
     *  "what's inside X" doesn't depend on which entity is focused. */
    focalId: string | null,
    /** Null = no provider reachable; every fetch degrades to 'unsupported'. */
    provider: GraphDataProvider | null,
): LensChildrenData {
    const [state, setState] = useState<ChildrenState>(emptyState)
    const inFlightRef = useRef<Set<string>>(new Set())
    const sessionRef = useRef(0)
    // `loadAllChildren` needs the page count already in state; it only
    // ever runs from an event handler, so a committed mirror is current by
    // the time it reads.
    const stateRef = useRef(state)
    useEffect(() => { stateRef.current = state }, [state])

    const pageChildren = useCallback((urn: string, searchQuery = '') => {
        if (!provider) {
            setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, urn, 'unsupported') }))
            return
        }
        if (inFlightRef.current.has(urn)) return

        const q = searchQuery.trim()
        const loaded = stateRef.current.allResults.get(urn)
        // A changed search is a different question — page it from zero
        // instead of appending matches to the previous answer.
        const sameQuery = (loaded?.query ?? '') === q
        if (loaded && sameQuery && !loaded.hasMore) return   // fully drained already

        const session = sessionRef.current
        inFlightRef.current.add(urn)
        setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, urn, 'loading') }))

        void (async () => {
            try {
                const res = await provider.getChildrenWithEdges(urn, {
                    limit: CHILDREN_PAGE_SIZE,
                    offset: sameQuery ? (loaded?.children.length ?? 0) : 0,
                    includeLineageEdges: false,
                    // Server-side, so Find reaches a column on page 7 of a
                    // wide table without paging to it.
                    ...(q ? { searchQuery: q } : {}),
                })
                if (session !== sessionRef.current) return
                const page = res.children.map(n => toCanvasNode(n))
                setState(prev => {
                    const prevPage = prev.allResults.get(urn)
                    const children = sameQuery ? [...(prevPage?.children ?? []), ...page] : page
                    return {
                        ...prev,
                        allResults: setIn(prev.allResults, urn, {
                            children,
                            hasMore: res.hasMore,
                            // Draining the last page is the one moment we
                            // know the real count — the endpoint's own
                            // totalChildren is a paging heuristic, not one.
                            total: res.hasMore ? null : children.length,
                            query: q,
                        }),
                        allStatus: setIn(prev.allStatus, urn, 'done'),
                    }
                })
            } catch {
                if (session !== sessionRef.current) return
                setState(prev => ({ ...prev, allStatus: setIn(prev.allStatus, urn, 'error') }))
            } finally {
                inFlightRef.current.delete(urn)
            }
        })()
    }, [provider])

    const loadAllChildren = useCallback(
        (urn: string, searchQuery = '') => pageChildren(urn, searchQuery),
        [pageChildren],
    )
    const loadChildrenOf = useCallback((urn: string) => pageChildren(urn), [pageChildren])

    // Session lifecycle: clear everything when the lens closes so a new
    // session starts from the data source, not from a stale picture.
    useEffect(() => {
        if (focalId) return
        if (inFlightRef.current.size === 0 && stateRef.current.allResults.size === 0 && stateRef.current.allStatus.size === 0) return
        sessionRef.current += 1
        inFlightRef.current.clear()
        setState(emptyState())
    }, [focalId])

    return { allResults: state.allResults, allStatus: state.allStatus, loadAllChildren, loadChildrenOf }
}
