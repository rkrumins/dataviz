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
    /** Total the server found in the view — may exceed `hits.length`
     *  because only a page is fetched. `null` until it answers. */
    serverTotal: number | null
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

    const [serverHits, setServerHits] = useState<readonly SearchHit[]>([])
    const [serverTotal, setServerTotal] = useState<number | null>(null)
    const [isRunning, setIsRunning] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [truncated, setTruncated] = useState(false)
    const [deadlineExceeded, setDeadlineExceeded] = useState(false)
    const [elapsedMs, setElapsedMs] = useState<number | null>(null)

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

    useEffect(() => {
        if (!canSearchServer || !debouncedText) {
            runIdRef.current += 1
            setServerHits([])
            setServerTotal(null)
            setIsRunning(false)
            setErrorMessage(null)
            setTruncated(false)
            setDeadlineExceeded(false)
            setElapsedMs(null)
            return
        }

        const { predicate, error } = compileFind({
            text: debouncedText, mode: debouncedMode, scope: debouncedScope,
        })
        if (!predicate) {
            // A half-typed query (unbalanced parens, dangling operator).
            // The panel renders `compiled.error`; there is nothing to run.
            runIdRef.current += 1
            setServerHits([])
            setServerTotal(null)
            setIsRunning(false)
            setErrorMessage(error ?? null)
            return
        }

        const myRun = ++runIdRef.current
        setIsRunning(true)
        setErrorMessage(null)
        const startedAt = performance.now()

        const query: SearchQuery = stampViewScope(
            {
                predicate,
                options: {
                    results: 'hits',
                    includeAncestorPath: true,
                    pageSize: SERVER_PAGE_SIZE,
                    sort: 'relevance',
                    candidateCap: CANDIDATE_CAP,
                    softDeadlineMs: SOFT_DEADLINE_MS,
                },
            },
            viewId,
            // Always 'view', never the rail's persisted mode. A user who
            // last left Advanced Search on 'visible' must not silently get
            // the loaded-only bug back in the header box.
            'view',
        )

        void (async () => {
            try {
                const page = await provider.searchAdvanced(query)
                if (runIdRef.current !== myRun) return   // superseded
                setServerHits(page.hits ?? [])
                setServerTotal(page.candidateCount ?? page.hits?.length ?? 0)
                setTruncated(Boolean(page.truncated))
                setDeadlineExceeded(Boolean(page.deadlineExceeded))
                setElapsedMs(Math.round(performance.now() - startedAt))
                setIsRunning(false)
            } catch (e) {
                if (runIdRef.current !== myRun) return
                // Local results are never destroyed by a server failure —
                // a partial answer beats an empty one.
                setErrorMessage(e instanceof Error ? e.message : String(e))
                setIsRunning(false)
                setElapsedMs(Math.round(performance.now() - startedAt))
            }
        })()
    }, [
        canSearchServer, debouncedText, debouncedMode, debouncedScope,
        provider, viewId,
    ])

    // ---- Merge ------------------------------------------------------------
    const hits = useMemo<readonly SearchHit[]>(() => {
        if (serverHits.length === 0) return localHits
        const byUrn = new Map<string, SearchHit>()
        for (const hit of localHits) {
            const urn = urnOf(hit)
            if (urn) byUrn.set(urn, hit)
        }
        // Server rows win: they carry the authoritative ancestor path.
        // Insertion order keeps local hits first, so the rows the user is
        // already reading don't reshuffle when the server answers.
        for (const hit of serverHits) {
            const urn = urnOf(hit)
            if (urn) byUrn.set(urn, hit)
        }
        return Array.from(byUrn.values())
    }, [localHits, serverHits])

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
        setServerHits([])
        setServerTotal(null)
        setIsRunning(false)
        setErrorMessage(null)
        setTruncated(false)
        setDeadlineExceeded(false)
        setElapsedMs(null)
        const store = useSearchStore.getState()
        if (store.resultSource === 'quick') store.clearSearchResults()
    }, [])

    const isStale = trimmed !== debouncedText

    const status: FindStatus = !trimmed
        ? 'idle'
        : !canSearchServer
            ? 'localOnly'
            : errorMessage
                ? 'error'
                : (isRunning || isStale)
                    ? 'running'
                    : 'ready'

    return {
        text, mode, scope,
        setText, setMode, setScope, clear,
        hits,
        localCount: localUrns.size,
        serverTotal,
        status,
        errorMessage,
        truncated,
        deadlineExceeded,
        elapsedMs,
        compiled,
        isStale,
    }
}
