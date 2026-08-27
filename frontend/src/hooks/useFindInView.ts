/**
 * useFindInView — the Context View header's search, end to end.
 *
 * The box used to filter `displayFlat` with a substring test on two
 * fields. That could only ever find what the browser had already
 * downloaded, and on a lazily-hydrated canvas that is a small and
 * arbitrary slice of the view: a user searching for a column inside a
 * collapsed table got "no results" for data that plainly exists.
 *
 * So this hook answers every query twice.
 *
 *   Tier 1 (local, per keystroke, no network) ranks the nodes already in
 *   hand. It exists so the box responds instantly, and it is complete for
 *   the part of the view on screen.
 *
 *   Tier 2 (server, debounced) compiles the same query into a predicate
 *   and runs it through the same view-scoped `/search/advanced` endpoint
 *   the Advanced Search rail uses. This is the tier that can see the
 *   entities nobody has expanded yet, and it is where the view boundary
 *   is enforced — server-side, on every request.
 *
 * Results merge by URN, local first so the instant answer never jumps
 * out from under a user mid-read, with the server's row winning any
 * conflict (it carries the authoritative ancestor path).
 *
 * Two invariants hold the whole thing together:
 *
 *   **Search never writes to the canvas store.** Results live here.
 *   Revealing a hit is a separate, deliberate act (`useRevealSearchHit`).
 *   The per-node child search this replaces violated exactly this, and
 *   deleted a parent's loaded children to display its matches.
 *
 *   **Every published hit carries an ancestor path.** The store derives
 *   its "3 matches inside" roll-up badges from those paths, so a hit
 *   without one is invisible on a collapsed tree — the single worst
 *   failure mode a search over a hierarchy can have.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
    compileFind,
    type CompiledFind,
    type FindMode,
    type FindScope,
} from '@/components/canvas/search/find/compileFind'
import {
    ancestorPathFor,
    buildLocalNodeIndex,
    matchLocalNodes,
    toSyntheticHit,
    LOCAL_HIT_LIMIT,
} from '@/components/canvas/search/find/localNodeIndex'
import { rankHits } from '@/components/canvas/search/find/rankHits'
import { stampViewScope } from '@/components/canvas/search/panel/stampViewScope'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore, type AncestorPathInfo } from '@/store/searchStore'
import type { HierarchyNode } from '@/types/hierarchy'
import type { SearchHit, SearchQuery } from '@/types/search'

import { useDebouncedValue } from './useDebouncedValue'


/** Local hits render on the keystroke; the canvas spotlight waits this
 *  long so typing doesn't re-render every layer column per character. */
const PUBLISH_DEBOUNCE_MS = 200

/** The server tier waits slightly longer than the spotlight, so a burst
 *  of typing costs one request rather than one per character. */
const SERVER_DEBOUNCE_MS = 250

/** Interactive path — a search box must not sit on a 30s default. */
const SOFT_DEADLINE_MS = 8000

const SERVER_PAGE_SIZE = 100

/** Matches DEFAULT_DRAFT_OPTIONS in the search store. */
const CANDIDATE_CAP = 5000


/** Frozen so the merge memo keeps its identity while the server has
 *  nothing to add. */
const EMPTY_HITS: readonly SearchHit[] = Object.freeze([])


/** The server's answer to one query, accumulated across pages. */
interface ServerRun {
    key: string
    /** The predicate this run was dispatched with. Held so `loadMore`
     *  pages the query that produced these hits: the live `compiled` can
     *  already be a keystroke ahead of the debounced run. */
    predicate: NonNullable<CompiledFind['predicate']>
    hits: readonly SearchHit[]
    total: number | null
    /** Opaque cursor for the next page; null when the set is exhausted.
     *  The backend echoes one whenever the page didn't reach the end of
     *  the sorted hits. Dropping it capped this box at one page. */
    cursor: string | null
    /** True while a `loadMore` is in flight. Distinct from the initial
     *  run: the panel keeps showing the rows it has instead of flipping
     *  to a spinner. */
    loadingMore: boolean
    truncated: boolean
    deadlineExceeded: boolean
    elapsedMs: number | null
    error: string | null
}


export type FindStatus =
    /** Nothing typed. */
    | 'idle'
    /** Typed, and the server tier hasn't answered yet. */
    | 'running'
    /** Both tiers have answered. */
    | 'ready'
    /** No live backend — local results only, and the panel says so. */
    | 'localOnly'
    /** The server tier failed. Local results survive. */
    | 'error'


export interface UseFindInViewArgs {
    /** Empty string degrades to local-only: the backend requires a
     *  resolvable view to scope against, and refuses to guess. */
    viewId: string
    displayFlat: readonly HierarchyNode[]
    parentMap: ReadonlyMap<string, string>
    displayMap: ReadonlyMap<string, HierarchyNode>
}


export interface FindInViewState {
    text: string
    mode: FindMode
    scope: FindScope
    setText: (t: string) => void
    setMode: (m: FindMode) => void
    setScope: (s: FindScope) => void
    clear: () => void

    /** Merged and deduped, local first. Feed straight to `HitsByParent`. */
    hits: readonly SearchHit[]
    /** How many of `hits` came from the canvas already on screen. */
    localCount: number
    /** Total the server found in the view — exceeds `hits.length` until
     *  every page is loaded. `null` until it answers. */
    serverTotal: number | null
    /** More pages exist. While true the result set is PROVISIONAL: the
     *  canvas spotlight and the stepper cover only what has loaded, so
     *  the UI must not imply the list is the whole answer. */
    hasMore: boolean
    /** Fetch the next page and append it. No-op without a cursor. */
    loadMore: () => void
    /** A `loadMore` is in flight. */
    isLoadingMore: boolean
    status: FindStatus
    errorMessage: string | null
    /** The server hit its candidate cap: there are more matches than it
     *  looked at. Surfaced, never swallowed. */
    truncated: boolean
    deadlineExceeded: boolean
    elapsedMs: number | null
    compiled: CompiledFind
    /** True while the user has typed something the tiers haven't caught
     *  up with — drives the running affordance without a flash. */
    isStale: boolean
}


function urnOf(hit: SearchHit): string {
    return hit.node?.urn ?? ''
}


export function useFindInView({
    viewId, displayFlat, parentMap, displayMap,
}: UseFindInViewArgs): FindInViewState {
    const provider = useGraphProvider()

    const [text, setText] = useState('')
    const [mode, setMode] = useState<FindMode>('contains')
    const [scope, setScope] = useState<FindScope>('everything')

    // The server's answer, tagged with the query it answers. Keying it
    // this way makes "is a request outstanding" DERIVED — the tag doesn't
    // match what is being asked — rather than a second piece of state an
    // effect has to keep in sync. No reset on every keystroke, and no
    // window where the two disagree.
    const [serverRun, setServerRun] = useState<ServerRun | null>(null)

    // Monotonic run id rather than an AbortController: RemoteGraphProvider
    // shares one in-flight promise across identical requests, so aborting
    // would reject a promise other callers are awaiting. Discarding a
    // stale result achieves the same thing and lets the dedupe work FOR
    // us — backspacing to a query already in flight costs no round-trip.
    const runIdRef = useRef(0)

    const trimmed = text.trim()
    const compiled = useMemo(
        () => compileFind({ text, mode, scope }),
        [text, mode, scope],
    )

    // ---- Tier 1: local ----------------------------------------------------
    // Rebuilds when the canvas hydrates, never while the user types:
    // `displayFlat` is memoized on the layer assignment upstream.
    const index = useMemo(() => buildLocalNodeIndex(displayFlat), [displayFlat])

    const localHits = useMemo<readonly SearchHit[]>(() => {
        if (!trimmed) return []
        const { hits } = matchLocalNodes(index, trimmed, mode, scope, LOCAL_HIT_LIMIT)
        return hits.map((node) =>
            toSyntheticHit(node, ancestorPathFor(node, parentMap, displayMap)))
    }, [index, trimmed, mode, scope, parentMap, displayMap])

    // ---- Tier 2: server ---------------------------------------------------
    const isRemote = provider instanceof RemoteGraphProvider
    const canSearchServer = isRemote && viewId.length > 0

    const debouncedText = useDebouncedValue(trimmed, SERVER_DEBOUNCE_MS)
    const debouncedMode = useDebouncedValue(mode, SERVER_DEBOUNCE_MS)
    const debouncedScope = useDebouncedValue(scope, SERVER_DEBOUNCE_MS)

    const serverActive = canSearchServer && debouncedText.length > 0
    const runKey = serverActive
        ? `${debouncedMode}|${debouncedScope}|${debouncedText}`
        : ''

    /** The request for one page. `cursor` is null for the first. */
    const buildQuery = useCallback((
        predicate: NonNullable<CompiledFind['predicate']>,
        cursor: string | null,
    ): SearchQuery => stampViewScope(
        {
            predicate,
            options: {
                results: 'hits',
                includeAncestorPath: true,
                pageSize: SERVER_PAGE_SIZE,
                // Accepted, but the backend has no relevance signal in v1
                // and falls back to display name. `rankHits` re-sorts what
                // comes back so the list obeys one rule; asking for it
                // anyway means this starts working for free if the server
                // ever gains one.
                sort: 'relevance',
                candidateCap: CANDIDATE_CAP,
                softDeadlineMs: SOFT_DEADLINE_MS,
                ...(cursor ? { cursor } : {}),
            },
        },
        viewId,
        // Always 'view', never the rail's persisted mode. A user who last
        // left Advanced Search on 'visible' must not silently get the
        // loaded-only bug back in the header box.
        'view',
    ), [viewId])

    useEffect(() => {
        if (!serverActive) return

        const { predicate } = compileFind({
            text: debouncedText, mode: debouncedMode, scope: debouncedScope,
        })
        // A half-typed query (unbalanced parens, dangling operator) has
        // nothing to run. The panel renders `compiled.error` instead.
        if (!predicate) return

        const myRun = ++runIdRef.current
        const startedAt = performance.now()
        const query = buildQuery(predicate, null)

        void (async () => {
            try {
                const page = await provider.searchAdvanced(query)
                if (runIdRef.current !== myRun) return   // superseded
                setServerRun({
                    key: runKey,
                    predicate,
                    hits: page.hits ?? [],
                    total: page.candidateCount ?? page.hits?.length ?? 0,
                    cursor: page.cursor ?? null,
                    loadingMore: false,
                    truncated: Boolean(page.truncated),
                    deadlineExceeded: Boolean(page.deadlineExceeded),
                    elapsedMs: Math.round(performance.now() - startedAt),
                    error: null,
                })
            } catch (e) {
                if (runIdRef.current !== myRun) return
                // Local results are never destroyed by a server failure —
                // a partial answer beats an empty one.
                setServerRun({
                    key: runKey,
                    predicate,
                    hits: [],
                    total: null,
                    cursor: null,
                    loadingMore: false,
                    truncated: false,
                    deadlineExceeded: false,
                    elapsedMs: Math.round(performance.now() - startedAt),
                    error: e instanceof Error ? e.message : String(e),
                })
            }
        })()
    }, [
        serverActive, runKey, debouncedText, debouncedMode, debouncedScope,
        provider, viewId, buildQuery,
    ])

    // Only the answer to the question currently being asked counts.
    const server = serverRun && serverRun.key === runKey ? serverRun : null
    const serverHits = server?.hits ?? EMPTY_HITS

    /**
     * Fetch the next page and APPEND it.
     *
     * The run key stays pinned to the query while paging — a page that
     * replaced the key would make every page already accumulated look
     * stale and get discarded. The run-id guard still applies, so a page
     * that lands after the user has typed something else is dropped.
     */
    const loadMore = useCallback(() => {
        const run = server
        if (!run || !run.cursor || run.loadingMore) return
        if (!(provider instanceof RemoteGraphProvider)) return

        const cursor = run.cursor
        const myRun = runIdRef.current
        setServerRun((prev) =>
            prev && prev.key === run.key ? { ...prev, loadingMore: true } : prev)

        void (async () => {
            try {
                const page = await provider.searchAdvanced(
                    buildQuery(run.predicate, cursor),
                )
                if (runIdRef.current !== myRun) return   // superseded
                setServerRun((prev) => {
                    if (!prev || prev.key !== run.key) return prev
                    return {
                        ...prev,
                        hits: [...prev.hits, ...(page.hits ?? [])],
                        cursor: page.cursor ?? null,
                        loadingMore: false,
                        // A later page can still report truncation.
                        truncated: prev.truncated || Boolean(page.truncated),
                    }
                })
            } catch (e) {
                if (runIdRef.current !== myRun) return
                // Keep the pages already loaded; only report the failure.
                setServerRun((prev) => {
                    if (!prev || prev.key !== run.key) return prev
                    return {
                        ...prev,
                        loadingMore: false,
                        error: e instanceof Error ? e.message : String(e),
                    }
                })
            }
        })()
    }, [server, provider, buildQuery])


    // ---- Merge ------------------------------------------------------------
    const hits = useMemo<readonly SearchHit[]>(() => {
        if (serverHits.length === 0) return localHits
        const byUrn = new Map<string, SearchHit>()
        for (const hit of localHits) {
            const urn = urnOf(hit)
            if (urn) byUrn.set(urn, hit)
        }
        // Server rows win: they carry the authoritative ancestor path.
        // Insertion order keeps local hits first, which `rankHits` then
        // uses as its stable tiebreak.
        for (const hit of serverHits) {
            const urn = urnOf(hit)
            if (urn) byUrn.set(urn, hit)
        }
        // One ordering rule for the whole list. Without this the local
        // half is relevance-ranked and the server half is alphabetical
        // (the backend has no relevance signal in v1), so the best match
        // could sit below a worse one purely because of where it came
        // from. Loading another page genuinely improves the order, which
        // is why the panel says the list is provisional until it's done.
        return rankHits(Array.from(byUrn.values()), trimmed)
    }, [localHits, serverHits, trimmed])

    const localUrns = useMemo(() => {
        const s = new Set<string>()
        for (const hit of localHits) {
            const urn = urnOf(hit)
            if (urn) s.add(urn)
        }
        return s
    }, [localHits])

    // ---- Publish to the canvas -------------------------------------------
    // Debounced: this is what drives the spotlight, the isolate/exclude
    // filter and the roll-up badges, and every publish re-renders the
    // columns. Local hits still render in the panel on the keystroke.
    const debouncedHits = useDebouncedValue(hits, PUBLISH_DEBOUNCE_MS)

    useEffect(() => {
        const store = useSearchStore.getState()
        if (!trimmed || debouncedHits.length === 0) {
            // Only tear down results this hook owns — the rail may have
            // published its own, and clearing those out from under it
            // would be the same bug in the other direction.
            if (store.resultSource === 'quick') store.clearSearchResults()
            return
        }
        const matchUrns: string[] = []
        const ancestorPaths: AncestorPathInfo[] = []
        for (const hit of debouncedHits) {
            const urn = urnOf(hit)
            if (!urn) continue
            matchUrns.push(urn)
            if (hit.ancestorPath && hit.ancestorPath.length > 0) {
                ancestorPaths.push({
                    path: hit.ancestorPath,
                    leafEntityType: hit.node?.entityType ?? '',
                })
            }
        }
        store.setResult({
            viewId: viewId || 'local',
            matchUrns,
            ancestorPaths,
            queryHash: `find:${mode}:${scope}:${trimmed}`,
            source: 'quick',
        })
    }, [debouncedHits, trimmed, viewId, mode, scope])

    // Drop the spotlight when the canvas unmounts or the view changes —
    // otherwise stale matches keep glowing on a view they don't belong to.
    useEffect(() => () => {
        const store = useSearchStore.getState()
        if (store.resultSource === 'quick') store.clearSearchResults()
    }, [])

    const clear = useCallback(() => {
        runIdRef.current += 1
        setText('')
        setServerRun(null)
        const store = useSearchStore.getState()
        if (store.resultSource === 'quick') store.clearSearchResults()
    }, [])

    const isStale = trimmed !== debouncedText
    // Outstanding when the server tier is live, the query compiles, and no
    // answer tagged with the current question has come back yet.
    const isRunning = serverActive && !server && compiled.predicate !== null

    const status: FindStatus = !trimmed
        ? 'idle'
        : !canSearchServer
            ? 'localOnly'
            : server?.error
                ? 'error'
                : (isRunning || isStale)
                    ? 'running'
                    : 'ready'

    return {
        text, mode, scope,
        setText, setMode, setScope, clear,
        hits,
        localCount: localUrns.size,
        serverTotal: server?.total ?? null,
        hasMore: Boolean(server?.cursor),
        loadMore,
        isLoadingMore: Boolean(server?.loadingMore),
        status,
        errorMessage: server?.error ?? null,
        truncated: server?.truncated ?? false,
        deadlineExceeded: server?.deadlineExceeded ?? false,
        elapsedMs: server?.elapsedMs ?? null,
        compiled,
        isStale,
    }
}
