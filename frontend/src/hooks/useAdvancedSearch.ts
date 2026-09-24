/**
 * State machine + provider orchestration for the SearchMapPanel.
 *
 * Three responsibilities:
 *   1. Hold the current view: idle → templateSelected → running → results,
 *      with the active template inputs / parsed query alongside.
 *   2. Talk to the backend through RemoteGraphProvider.searchAdvanced,
 *      with abort-on-restart so a stale request can never overwrite a
 *      fresh one (e.g. user re-runs while a slow query is still in flight).
 *   3. Report which draft the current results belong to (``runState``)
 *      so the editor knows whether it has unrun changes.
 *
 * Scoping to a container is NOT tracked here. It used to be: the hook
 * kept a drill stack and `stampScope` gave the top frame absolute
 * precedence over `scope.rootUrns`. Because nothing ever popped that
 * stack, one click on a result group silently clamped every later query
 * to that container — the panel appeared to return 0 matches forever
 * until it was closed and reopened (which remounted this hook and reset
 * the stack). Scope is now an ordinary `descendantOf` row in the user's
 * own draft: visible, editable, undoable, and compiled into the very
 * same root-URN clamp server-side. See `predicateComposition.setScopeCondition`.
 *
 * The view's OWN roots aren't computed here either. `scope.rootUrns` is
 * now only ever a caller-supplied narrowing (a template that targets one
 * container): the backend resolves the view's boundary from
 * `scope.viewId` on every request and only ever intersects a client hint
 * with it, so sending a client-side guess could narrow the search but
 * never widen it — and when the guess was stale or truncated it hid real
 * matches.
 *
 * Not stored: the raw-JSON / Explain / Discover surfaces — those live
 * in the SearchMapPanel's "Power tools" tab and share the same query
 * pipeline through `runPredicate`. The hook stays focused on
 * template-driven + visual-builder paths.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { rememberUrnLabels } from '@/lib/urnLabels'
import { useCanvasStore } from '@/store/canvas'
import {
    DEFAULT_DRAFT_OPTIONS,
    useSearchStore,
    type AncestorCountInfo,
    type AncestorPathInfo,
} from '@/store/searchStore'
import type {
    AggregationSpec,
    AncestorRef,
    Predicate,
    SearchAggregateBucket,
    SearchQuery,
    SearchResultPage,
    SearchScope,
} from '@/types/search'

import {
    defaultInputs,
    findTemplate,
    type SearchTemplate,
} from '@/components/canvas/search/searchTemplates'
import { stringifyPredicate } from '@/components/canvas/search/panel/predicateDsl'
import { recordEvent } from '@/services/telemetryService'


/**
 * Whitelist of predicate kinds the user might want to re-run from the
 * Recent list. Path-mode and aggregation-driven templates aren't
 * meaningfully "re-runnable as a free-form draft" — they need their
 * full SearchQuery context, not just the predicate.
 */
const RECENTABLE_KINDS = new Set([
    'group', 'text', 'property', 'tag', 'hasProperty',
    'entityType', 'layer', 'descendantOf', 'withinHops',
    'degree', 'isOrphan', 'isLeaf', 'isRoot',
    'hasIncoming', 'hasOutgoing',
])

function isRecentablePredicate(p: Predicate): boolean {
    return RECENTABLE_KINDS.has(p.kind ?? '')
}


/**
 * Walks a predicate tree looking for any PathPredicate. The backend
 * only allows PathPredicate at top-level AND, but the user may have
 * authored it nested inside an AND group via the builder — either way
 * detect it so we can switch the request shape to `results: 'paths'`.
 */
function containsPathPredicate(p: Predicate): boolean {
    if (p.kind === 'path') return true
    if (p.kind === 'group') {
        return p.children.some(containsPathPredicate)
    }
    return false
}


/**
 * Collect every node URN the user should perceive as "matched" by a
 * given result page — flat hits AND each aggregate bucket's
 * sampleHits. Aggregate-only mode (no `hits` in the response) still
 * lights up the preview hits on the canvas this way.
 */
function collectMatchUrns(result: SearchResultPage): string[] {
    const urns: string[] = []
    if (result.hits) {
        for (const hit of result.hits) {
            const u = hit.node?.urn
            if (u) urns.push(u)
        }
    }
    if (result.aggregates) {
        for (const facet of result.aggregates) {
            for (const bucket of facet) {
                for (const hit of bucket.sampleHits ?? []) {
                    const u = hit.node?.urn
                    if (u) urns.push(u)
                }
            }
        }
    }
    // Path mode: highlight every node that appears on any returned
    // path. This lets the canvas show the entire traversal chain.
    if (result.paths) {
        for (const path of result.paths) {
            for (const node of path.nodes) {
                if (node.urn) urns.push(node.urn)
            }
        }
    }
    return urns
}


/**
 * Pull the ancestor chain off every hit (and every sample-hit inside
 * aggregate buckets), paired with the entity type of the leaf hit, so
 * the canvas can roll up both a total count AND a per-entityType
 * breakdown for each ancestor URN ("3 inside · 2 fields, 1 dataset").
 *
 * Aggregate buckets already encode "this ancestor has N matches under
 * it" via ``bucket.matchCount``, but we still emit synthetic ancestor
 * paths for their sample hits — that lets a collapsed grandparent
 * surface its rolled-up subtree count even in aggregate-only mode.
 */
/**
 * Structural shape we read off any hit-like object: the generated
 * SearchHit and the curated one (with the FE-patched GraphNode) both
 * satisfy this — we only touch ancestorPath + node.entityType so a
 * minimal contract is enough to avoid the dual-type assignment friction.
 */
type AnyHitLike = {
    ancestorPath?: ReadonlyArray<AncestorRef> | null
    node?: { entityType?: string } | null
}

function collectAncestorPaths(result: SearchResultPage): AncestorPathInfo[] {
    const paths: AncestorPathInfo[] = []
    const push = (hit: AnyHitLike) => {
        if (hit.ancestorPath && hit.ancestorPath.length > 0) {
            paths.push({
                path: hit.ancestorPath,
                leafEntityType: hit.node?.entityType ?? '',
            })
        }
    }
    if (result.hits) {
        for (const hit of result.hits) push(hit)
    }
    if (result.aggregates) {
        for (const facet of result.aggregates) {
            for (const bucket of facet) {
                for (const hit of bucket.sampleHits ?? []) push(hit)
            }
        }
    }
    return paths
}


// The two helpers below are the ONLY place the ancestor facet is named —
// the seam B4b flips onto the backend's dedicated `ancestor` aggregation,
// whose buckets count a match under EVERY ancestor, not just its parent.

/** Does this facet carry per-ancestor match counts? */
const isAncestorFacet = (spec: AggregationSpec | undefined): boolean =>
    spec?.by === 'ancestor'

/** The facet's per-entityType split of one bucket's matches. */
const facetBreakdown = (
    bucket: SearchAggregateBucket,
): ReadonlyArray<[string, number]> =>
    Object.entries(bucket.typeCounts ?? {})


/**
 * The server's exact per-ancestor match counts, or undefined when this
 * query didn't ask for them (path mode, an explicit hits-only override).
 *
 * Buckets carry no `by`, so a facet is identified positionally:
 * ``result.aggregates[i]`` answers ``query.options.aggregations[i]``.
 * Undefined — not an empty list — is what makes ``setResult`` fall back
 * to the page-derived rollup; an empty list is a real answer ("nothing
 * has matches inside it").
 */
function collectAncestorCounts(
    query: SearchQuery,
    result: SearchResultPage,
): AncestorCountInfo[] | undefined {
    const specs = query.options?.aggregations
    if (!specs || !result.aggregates) return undefined
    let asked = false
    const counts: AncestorCountInfo[] = []
    result.aggregates.forEach((facet, i) => {
        if (!isAncestorFacet(specs[i])) return
        asked = true
        for (const bucket of facet) {
            const breakdown = facetBreakdown(bucket)
            counts.push({
                urn: bucket.ancestorUrn,
                count: bucket.matchCount,
                breakdown: breakdown.length > 0 ? new Map(breakdown) : undefined,
            })
        }
    })
    return asked ? counts : undefined
}


/** The server's default ``maxBuckets`` for a facet that names none. */
const DEFAULT_MAX_BUCKETS = 50

/** The server reads at most this many containers a request. */
const ANCESTOR_URNS_PER_REQUEST = 2000

/** Let a burst of loads (an expand-all) settle before asking. */
const CONTAINER_COUNTS_DEBOUNCE_MS = 150

/**
 * Where a finished search's ``ancestor`` facet is, when it came back full:
 * it lists only the ``maxBuckets`` fullest containers, so a container on
 * the canvas holding fewer matches is missing from it — its exact count
 * is read from the search's session instead. -1 when there is nothing to
 * read: no such facet, a facet that already lists every container holding
 * a match, or a search that did not finish.
 */
function fullAncestorFacet(query: SearchQuery, result: SearchResultPage): number {
    if (result.status !== 'complete' || !result.sessionId) return -1
    const specs = query.options?.aggregations ?? []
    const i = specs.findIndex(isAncestorFacet)
    const facet = i >= 0 ? result.aggregates?.[i] : undefined
    if (!facet) return -1
    return facet.length >= (specs[i].maxBuckets ?? DEFAULT_MAX_BUCKETS) ? i : -1
}

/** The containers the canvas has loaded — nodes with children, expanded
 *  or not. */
function loadedContainerUrns(): string[] {
    const urns = new Set<string>()
    for (const n of useCanvasStore.getState().nodes) {
        const d = n.data
        const children = d?.childCount || d?._collapsedChildCount || d?.childIds?.length || 0
        const urn = d?.urn ?? n.id
        if (children > 0 && urn) urns.add(urn)
    }
    return [...urns]
}


// ---------------------------------------------------------------------------
// Progressive search
// ---------------------------------------------------------------------------

/** How long the server may take before answering with what its scan has
 *  found so far. It keeps scanning across the follow-up requests, each of
 *  which waits as long again — so a large graph shows its first matches
 *  within a second and its exact count when the scan ends. */
export const PROGRESS_WAIT_MS = 800

/** A follow-up that fails is retried this often, backing off, before the
 *  search stops where it is. */
const CONTINUE_ATTEMPTS = 3

function progressive(query: SearchQuery): SearchQuery {
    return { ...query, options: { ...(query.options ?? {}), waitMs: PROGRESS_WAIT_MS } }
}

/**
 * The next answer of a running search: the same request, naming its
 * session. A failure is retried; if it persists, the search stops at the
 * last answer — marked as cut short, so the count reads as a floor and the
 * panel says the search did not finish.
 */
async function continueSession(
    provider: RemoteGraphProvider,
    query: SearchQuery,
    last: SearchResultPage,
    signal: AbortSignal,
): Promise<SearchResultPage> {
    const next: SearchQuery = {
        ...query, options: { ...(query.options ?? {}), sessionId: last.sessionId ?? undefined },
    }
    for (let attempt = 0; ; attempt++) {
        try {
            return await provider.searchAdvanced(next, { signal })
        } catch (e) {
            if (signal.aborted || attempt + 1 >= CONTINUE_ATTEMPTS) {
                if (signal.aborted) throw e
                return { ...last, status: undefined, truncated: true, deadlineExceeded: true }
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
        }
    }
}


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PanelView =
    | { kind: 'idle' }                                          // template picker
    | { kind: 'templateSelected'; template: SearchTemplate;     // params form
        inputs: Record<string, string | number> }
    | { kind: 'running'; template: SearchTemplate;               // spinner
        inputs: Record<string, string | number>;
        query: SearchQuery; startedAt: number }
    | { kind: 'results'; template: SearchTemplate;               // cards/rows
        inputs: Record<string, string | number>;
        query: SearchQuery; result: SearchResultPage;
        elapsedMs: number }
    | { kind: 'error'; template: SearchTemplate;                 // error card
        inputs: Record<string, string | number>;
        query: SearchQuery; message: string;
        elapsedMs: number }

/**
 * Which draft the panel has actually dispatched, and how that went.
 *
 * Lives here rather than in QueryCard because it describes the state of
 * a *request*, not of an editor: QueryCard used to set it optimistically
 * at dispatch time and never clear it, so a run that aborted or errored
 * left the identical draft permanently un-rerunnable. It also unmounts
 * whenever the Advanced drawer opens, which made the behaviour look
 * random. ``hash`` is ``JSON.stringify`` of the pre-scope-stamp
 * predicate — the same string ``buildRunnablePredicate`` produces.
 */
export interface RunState {
    hash: string
    status: 'running' | 'done' | 'failed'
}


export interface UseAdvancedSearchResult {
    view: PanelView
    /** Which draft produced the current view, and how it went. Null
     *  before the first run and after an explicit cancel/reset. */
    runState: RunState | null
    /** True when no template has been selected yet. */
    isIdle: boolean
    /** Pick a template — moves the view to `templateSelected` with default inputs. */
    selectTemplate: (templateId: string) => void
    /** Update one input on the active template. */
    setInput: (name: string, value: string | number) => void
    /** Pop back to the template picker. */
    resetTemplate: () => void
    /** Run the search with the current template + inputs. */
    run: () => Promise<void>
    /** Run a template directly without going through the templateSelected
     *  intermediate state — used by the AskBar's one-click chips so the
     *  user never sees the form flash before results appear. Uses
     *  ``defaultInputs(template)`` unless explicit inputs are supplied. */
    runTemplate: (template: SearchTemplate,
                  inputs?: Record<string, string | number>) => Promise<void>
    /** Run a raw predicate tree (from the visual builder OR the AskBar).
     *  Bypasses the template form: stamps view scope, dispatches through
     *  the same running → results state machine.
     *  Optional ``optionsOverride`` lets free-form searches opt out of
     *  the default aggregation (so a 49-hit search renders 49 rows, not
     *  one bucket containing 49). */
    runPredicate: (predicate: Predicate,
                   optionsOverride?: SearchQuery['options']) => Promise<void>
    /** Abort any in-flight query and return to idle. */
    cancel: () => void
    /** Fetch the next page of hits using the cursor on the current
     *  result. No-op when ``view.kind !== 'results'`` or the result has
     *  no cursor. New hits are APPENDED to the existing list — the
     *  panel stays on the same query, just with a longer result page. */
    loadMore: () => Promise<void>
    /** True while a ``loadMore`` request is in flight. Drives the
     *  "Load more" button's spinner. */
    isLoadingMore: boolean
}


// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param viewId - REQUIRED. The view this search shell is bound to.
 *   The hook stamps `scope.viewId` onto every outgoing SearchQuery so
 *   the backend's ViewScopeResolver can enforce view boundaries. There
 *   is no global / cross-view search — every search is scoped to a view.
 * @param options.clearOnUnmount - Whether unmounting also wipes the
 *   published result-set. True (the default) is what the panel wants:
 *   it owns the highlights, so closing it takes them away. A caller
 *   whose search outlives its own mount — the header box, whose results
 *   stay on the canvas until the query is cleared — passes false.
 */
export function useAdvancedSearch(
    viewId: string,
    options?: { clearOnUnmount?: boolean },
): UseAdvancedSearchResult {
    const provider = useGraphProvider()
    const [view, setView] = useState<PanelView>({ kind: 'idle' })
    const [runState, setRunState] = useState<RunState | null>(null)
    const abortRef = useRef<AbortController | null>(null)

    // Read through a ref: the unmount effect runs once, so capturing the
    // option in its closure would pin whatever value the first render
    // happened to pass.
    const clearOnUnmountRef = useRef(true)
    clearOnUnmountRef.current = options?.clearOnUnmount !== false

    // Cancel any in-flight request when the hook unmounts (panel closed
    // mid-query). Otherwise the resolved promise would set state on an
    // unmounted component. Clearing the cross-component result-set — so
    // the canvas stops highlighting matches — is the caller's choice.
    useEffect(() => () => {
        abortRef.current?.abort()
        if (clearOnUnmountRef.current) useSearchStore.getState().clear()
    }, [])

    // Exact badges for every loaded container, not only the fullest ones
    // the ``ancestor`` facet lists: once a search has finished with a full
    // facet, the containers it left out are read from the search's session
    // — each once, and later-loaded ones as they arrive — and added to the
    // facet, so every publish (and every later page) carries them.
    const containersAsked = useRef<{ sessionId: string; urns: Set<string> } | null>(null)
    useEffect(() => {
        if (view.kind !== 'results' || !(provider instanceof RemoteGraphProvider)) return
        const { query, result } = view
        const index = fullAncestorFacet(query, result)
        const sessionId = result.sessionId
        if (index < 0 || !sessionId) return
        if (containersAsked.current?.sessionId !== sessionId) {
            containersAsked.current = { sessionId, urns: new Set() }
        }
        const asked = containersAsked.current.urns
        // The scope the search resolved (its hash binds the session);
        // the visible-URN list plays no part in it and can be long.
        const scope: SearchScope = { ...query.scope, visibleUrns: undefined }
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined

        const fill = async () => {
            const facet = result.aggregates?.[index] ?? []
            const listed = new Set(facet.map((b) => b.ancestorUrn))
            const pending = loadedContainerUrns().filter((u) => !listed.has(u) && !asked.has(u))
            const found: SearchAggregateBucket[] = []
            for (let i = 0; i < pending.length; i += ANCESTOR_URNS_PER_REQUEST) {
                const batch = pending.slice(i, i + ANCESTOR_URNS_PER_REQUEST)
                try {
                    const answer = await provider.searchAncestorCounts(
                        { scope, sessionId, urns: batch }, { signal: controller.signal })
                    if (controller.signal.aborted) return
                    for (const urn of batch) asked.add(urn)
                    // Expired: the session is gone and nothing more can be read.
                    if (answer.status !== 'complete') break
                    for (const [urn, c] of Object.entries(answer.counts)) {
                        if (c.count <= 0) continue
                        found.push({
                            ancestorUrn: urn,
                            ancestorDisplayName: c.displayName ?? '',
                            ancestorEntityType: c.entityType ?? '',
                            ancestorDepthFromScopeRoot: 0,
                            matchCount: c.count,
                            typeCounts: c.typeCounts,
                            sampleHits: [],
                        })
                    }
                } catch (err) {
                    if (controller.signal.aborted) return
                    // Non-fatal: those containers keep the page's rollup.
                    console.warn('[advancedSearch] container counts failed', err)
                    break
                }
            }
            if (found.length === 0) return
            const augmented: SearchResultPage = {
                ...result,
                aggregates: result.aggregates?.map((f, i) => (i === index ? [...f, ...found] : f)),
            }
            setView((v) => (v.kind === 'results' && v.result === result
                ? { ...v, result: augmented } : v))
            useSearchStore.getState().setResult({
                viewId,
                matchUrns: collectMatchUrns(augmented),
                ancestorPaths: collectAncestorPaths(augmented),
                ancestorCounts: collectAncestorCounts(query, augmented),
                queryHash: JSON.stringify(query),
            })
        }
        const ask = () => {
            clearTimeout(timer)
            timer = setTimeout(() => void fill(), CONTAINER_COUNTS_DEBOUNCE_MS)
        }
        ask()
        const unsubscribe = useCanvasStore.subscribe((s, prev) => {
            if (s.nodes !== prev.nodes) ask()
        })
        return () => {
            unsubscribe()
            clearTimeout(timer)
            controller.abort()
        }
    }, [view, provider, viewId])

    const selectTemplate = useCallback((templateId: string) => {
        const t = findTemplate(templateId)
        setView({
            kind: 'templateSelected',
            template: t,
            inputs: defaultInputs(t),
        })
    }, [])

    const setInput = useCallback((name: string, value: string | number) => {
        setView((v) => {
            if (v.kind === 'idle' || v.kind === 'running') return v
            return { ...v, inputs: { ...v.inputs, [name]: value } }
        })
    }, [])

    const resetTemplate = useCallback(() => {
        abortRef.current?.abort()
        // Drop any in-flight result-set publication from a prior run so
        // the canvas stops highlighting matches the moment the user
        // backs out of the form.
        useSearchStore.getState().clear()
        setRunState(null)
        setView({ kind: 'idle' })
    }, [])

    const stampScope = useCallback(
        (template: SearchTemplate,
         inputs: Record<string, string | number>): SearchQuery => {
            const raw = template.build(inputs)
            // ALWAYS stamp the viewId — the backend's ViewScopeResolver
            // requires it on every request.
            const scopeMode = useSearchStore.getState().scopeMode

            // Read live canvas state at call time so we don't capture
            // stale closures.
            const canvas = useCanvasStore.getState()

            // Collect the visible URN set straight from the canvas
            // store. Always attach when mode='visible' so the backend
            // doesn't have to guess.
            const visibleUrns = scopeMode === 'visible'
                ? Array.from(new Set(
                    canvas.nodes
                        .map((n) => n.id ?? n.data?.urn)
                        .filter((u): u is string => typeof u === 'string' && u.length > 0),
                ))
                : undefined

            // No rootUrns hint for the view itself: the backend
            // resolves the view's roots from ``scope.viewId`` and only
            // ever intersects a client hint with them. A template that
            // targets a specific container still rides through the
            // ``raw.scope`` spread below.
            const scope: SearchScope = {
                ...(raw.scope ?? {}),
                viewId,
                scopeMode,
                ...(visibleUrns ? { visibleUrns } : {}),
            }
            // Defensive normalisation: the backend's predicate compiler
            // currently mishandles bare top-level leaf predicates
            // (text / isOrphan / isLeaf / …) — they evaluate to zero
            // results even when an equivalent group-wrapped version
            // returns the expected hits. Wrap leaf-rooted predicates in
            // a single-child AND group so every outgoing request has the
            // shape the compiler is happy with. No-op when the root is
            // already a group.
            const predicate = raw.predicate.kind === 'group'
                ? raw.predicate
                : { kind: 'group' as const, op: 'and' as const,
                    children: [raw.predicate] }
            return { ...raw, predicate, scope }
        },
        [viewId],
    )

    const runWithInputs = useCallback(async (
        template: SearchTemplate,
        inputs: Record<string, string | number>,
        runKey: string | null,
    ) => {
        if (!(provider instanceof RemoteGraphProvider)) {
            setView({
                kind: 'error', template, inputs,
                query: stampScope(template, inputs),
                message:
                    'Active provider is not the remote backend — ' +
                    'advanced search only works against the live API.',
                elapsedMs: 0,
            })
            if (runKey) setRunState({ hash: runKey, status: 'failed' })
            return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const query = stampScope(template, inputs)
        const startedAt = performance.now()
        setView({ kind: 'running', template, inputs, query, startedAt })
        if (runKey) setRunState({ hash: runKey, status: 'running' })

        // Every page of a running search is shown as it lands: the hits are
        // already in their final order, only more of them are still coming.
        const show = (result: SearchResultPage) => {
            setView({
                kind: 'results', template, inputs, query, result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
            const ancestorPaths = collectAncestorPaths(result)
            rememberUrnLabels(ancestorPaths.flatMap((p) => p.path))
            useSearchStore.getState().setResult({
                viewId,
                matchUrns: collectMatchUrns(result),
                ancestorPaths,
                ancestorCounts: collectAncestorCounts(query, result),
                queryHash: JSON.stringify(query),
            })
        }

        try {
            let result = await provider.searchAdvanced(
                progressive(query), { signal: controller.signal })
            // An aborted run has been superseded — the newer run owns
            // both the view and the run state, so touch neither.
            if (controller.signal.aborted) return
            while (result.status === 'running' && result.sessionId) {
                show(result)
                result = await continueSession(
                    provider, progressive(query), result, controller.signal)
                if (controller.signal.aborted) return
            }
            setView({
                kind: 'results', template, inputs, query, result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
            if (runKey) setRunState({ hash: runKey, status: 'done' })
            // Every ancestor ref and aggregate bucket ships a
            // displayName. Remember them so a scope row built from
            // these results can render "inside GOLD" rather than the
            // raw URN — the container often isn't loaded on the canvas,
            // so this response is the only place the name exists.
            const ancestorPaths = collectAncestorPaths(result)
            rememberUrnLabels(ancestorPaths.flatMap((p) => p.path))
            for (const facet of result.aggregates ?? []) {
                rememberUrnLabels(facet.map((b) => ({
                    urn: b.ancestorUrn,
                    displayName: b.ancestorDisplayName,
                })))
            }
            // Publish the match URN set so the ContextView canvas
            // (W3 — useSearchHighlight + SearchPinOverlay +
            // ChevronMatchBadge) can react. JSON.stringify is
            // deterministic enough for the consumer's "did the query
            // change?" check; a real fingerprint can replace it if
            // ordering ever becomes an issue.
            const matchUrns = collectMatchUrns(result)
            // A search that finds nothing is its own event type, mirroring the
            // `docs.search_miss` precedent: the zero-result queries are the
            // interesting ones — they say what people expected the graph to
            // contain and it didn't. The predicate is deliberately NOT sent;
            // it can carry node names, and this store holds no PII beyond the
            // actor id. The shape of the query is enough to spot a pattern.
            recordEvent(matchUrns.length > 0 ? 'graph.search' : 'graph.search_miss', {
                matches: matchUrns.length,
                template: template.id,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
            useSearchStore.getState().setResult({
                viewId,
                matchUrns,
                ancestorPaths,
                ancestorCounts: collectAncestorCounts(query, result),
                queryHash: JSON.stringify(query),
            })
            // Auto-save the dispatched predicate to per-view Recent.
            // Skips path-mode / template queries whose predicate isn't
            // a meaningful "free-form draft" the user could re-author.
            if (isRecentablePredicate(query.predicate)) {
                useSearchStore.getState().addRecent({
                    viewId,
                    predicate: query.predicate,
                    label: stringifyPredicate(query.predicate),
                })
            }
        } catch (e) {
            if (controller.signal.aborted) return
            setView({
                kind: 'error', template, inputs, query,
                message: (e as Error).message,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
            // Remember the failure against this draft so the auto-run
            // effect doesn't hammer a query that can't succeed. The
            // explicit Run button still forces a retry.
            if (runKey) setRunState({ hash: runKey, status: 'failed' })
            // On error, drop any previously-published result-set so the
            // canvas doesn't keep highlighting stale matches.
            useSearchStore.getState().clear()
        }
    }, [provider, stampScope, viewId])

    const run = useCallback(async () => {
        if (view.kind === 'idle' || view.kind === 'running') return
        await runWithInputs(view.template, view.inputs, null)
    }, [view, runWithInputs])

    const runTemplate = useCallback(
        async (template: SearchTemplate,
               inputs?: Record<string, string | number>) => {
            await runWithInputs(template, inputs ?? defaultInputs(template), null)
        },
        [runWithInputs],
    )

    const runPredicate = useCallback(async (
        predicate: Predicate,
        optionsOverride?: SearchQuery['options'],
    ) => {
        // Synthesize a transient template so the existing
        // running → results state machine handles builder-sourced
        // queries identically to template-sourced ones. The
        // SearchMapPanel reads view.template.id to distinguish
        // "back to builder" from "back to template form" — see the
        // `__builder__` id below.
        //
        // ``options`` MUST be set explicitly. The backend defaults to
        // ``results: 'aggregates'`` with ``aggregations: None`` — which
        // means a request with no options returns ``aggregates: []``
        // and no ``hits`` for any predicate.
        //
        // Path mode requires ``results: 'paths'`` because the response
        // shape is fundamentally different (ordered node→edge→node
        // sequences instead of flat hits / aggregates). Detect the
        // PathPredicate either at top-level or nested inside an AND
        // group (the backend allows the latter; the predicate is
        // hoisted out of the WHERE fragment).
        const isPathMode = containsPathPredicate(predicate)
        const draftOptions =
            useSearchStore.getState().draftOptions ?? DEFAULT_DRAFT_OPTIONS

        const defaultOptions: SearchQuery['options'] = isPathMode
            ? { results: 'paths' }
            : {
                results: 'both',
                pageSize: draftOptions.pageSize,
                aggregations: draftOptions.aggregations,
                includeAncestorPath: draftOptions.includeAncestorPath,
            }

        const syntheticTemplate: SearchTemplate = {
            id: '__builder__',
            label: 'Custom query',
            description: 'Built from the predicate editor.',
            icon: 'Wand2',
            section: 'find',
            inputs: [],
            build: () => ({
                predicate,
                scope: undefined,
                options: optionsOverride ?? defaultOptions,
            }),
        }
        // The run key must match the hash ``buildRunnablePredicate``
        // computes, so the editor can tell "these results are for the
        // draft I'm looking at" — hash the predicate as handed in,
        // before stampScope's defensive AND-wrap.
        await runWithInputs(syntheticTemplate, {}, JSON.stringify(predicate))
    }, [runWithInputs])

    // ---------------------------------------------------------------
    // loadMore — cursor pagination (W2.2).
    //
    // The backend returns ``result.cursor`` when more hits are
    // available (``hits.length == pageSize`` AND the slice didn't
    // exhaust the candidate set). Re-issuing the SAME query with
    // ``options.cursor`` set returns the next page; we append those
    // hits onto the existing result so the user sees a longer list,
    // not a replacement.
    //
    // Aggregations are pinned to the first page (re-running the
    // aggregation per pagination round-trip would be wasteful and
    // wouldn't change the bucket counts).
    // ---------------------------------------------------------------
    const [isLoadingMore, setIsLoadingMore] = useState(false)

    const loadMore = useCallback(async () => {
        if (view.kind !== 'results') return
        const cursor = view.result.cursor
        if (!cursor) return
        if (!(provider instanceof RemoteGraphProvider)) return
        if (isLoadingMore) return

        setIsLoadingMore(true)
        // Page 2 is abortable on the same terms as page 1: it closes over
        // the result it is appending to, so a page that lands after a new
        // run started would splice its hits onto a result the user has
        // already replaced.
        const controller = new AbortController()
        abortRef.current = controller
        try {
            const nextQuery: SearchQuery = {
                ...view.query,
                options: {
                    ...(view.query.options ?? {}),
                    cursor,
                    // Drop aggregations on subsequent pages — we
                    // already have them from page 1.
                    aggregations: undefined,
                    results: 'hits',
                },
            }
            let nextPage = await provider.searchAdvanced(
                nextQuery, { signal: controller.signal })
            if (controller.signal.aborted) return
            // A later page past what the search's session holds is a scan
            // of its own; a large one may take more than one request.
            while (nextPage.status === 'running' && nextPage.sessionId) {
                nextPage = await continueSession(
                    provider, nextQuery, nextPage, controller.signal)
                if (controller.signal.aborted) return
            }
            // Merge: append new hits, replace cursor (may now be null
            // signalling "no more pages"), keep aggregates from p1.
            //
            // APPEND ONLY — NEVER RE-SORT BY `score`. The page arrives in
            // the server's relevance order, computed over a projected
            // scan; each `hit.score` is then recomputed from the full
            // node, so the two are not the same number. Sorting the
            // merged list by `score` would silently reorder the page away
            // from the ranking the backend actually chose, and every
            // surface that reads "the first ten" would be reading a
            // different top ten from the one the panel's counts describe.
            const mergedHits = [
                ...(view.result.hits ?? []),
                ...(nextPage.hits ?? []),
            ]
            const merged: SearchResultPage = {
                ...view.result,
                hits: mergedHits,
                cursor: nextPage.cursor ?? undefined,
                candidateCount: nextPage.candidateCount
                    ?? view.result.candidateCount,
            }
            setView({
                ...view,
                result: merged,
            })
            // Recompute the canvas match-URN set from the merged page
            // so the spotlight covers newly-paginated hits too.
            useSearchStore.getState().setResult({
                viewId,
                matchUrns: collectMatchUrns(merged),
                ancestorPaths: collectAncestorPaths(merged),
                // ``merged`` keeps page 1's aggregates (nextQuery drops
                // them), so the badges stay exact instead of regressing
                // to a rollup over a now-longer hit list.
                ancestorCounts: collectAncestorCounts(view.query, merged),
                queryHash: JSON.stringify(view.query),
            })
        } catch (e) {
            if (controller.signal.aborted) return
            // On error, leave the existing result intact. We log here
            // (console — no project logger in the FE) rather than
            // swallowing silently; the user will see a stable page
            // and the next Run will surface any underlying issue.
            // eslint-disable-next-line no-console
            console.warn('loadMore failed', e)
        } finally {
            setIsLoadingMore(false)
        }
    }, [view, provider, isLoadingMore, viewId])

    const cancel = useCallback(() => {
        abortRef.current?.abort()
        // Drop any published result-set so the canvas doesn't keep
        // highlighting matches from a query the user explicitly killed.
        useSearchStore.getState().clear()
        // An aborted run never reports an outcome, so clear the run
        // state here — otherwise it would sit at 'running' forever and
        // the editor would think the draft was already dispatched.
        setRunState(null)
        if (view.kind === 'running') {
            // Restore the form so the user can adjust + retry without
            // losing their inputs.
            setView({
                kind: 'templateSelected',
                template: view.template,
                inputs: view.inputs,
            })
        }
    }, [view])

    // Memoised because callers hold this object, not its fields: the view
    // search session re-exposes it on a context, so a fresh literal every
    // render would re-render every consumer of that context on any
    // unrelated canvas state change. Every function below is already
    // `useCallback`ed, so the identity tracks the state.
    return useMemo(() => ({
        view,
        runState,
        isIdle: view.kind === 'idle',
        selectTemplate,
        setInput,
        resetTemplate,
        run,
        runTemplate,
        runPredicate,
        cancel,
        loadMore,
        isLoadingMore,
    }), [
        view, runState, selectTemplate, setInput, resetTemplate,
        run, runTemplate, runPredicate, cancel, loadMore, isLoadingMore,
    ])
}
