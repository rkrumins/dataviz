import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useCanvasStore, type ChildPageState, type LineageEdge, type LineageNode, type TypeFeedState } from '@/store/canvas'
import { primeLineageFor } from '@/lib/primeLineageFor'
import { useGraphProvider, useGraphProviderContext } from '@/providers/GraphProviderContext'
import {
    useActiveView,
    isContainmentEdgeType,
    normalizeEdgeType,
} from '@/store/schema'
import {
    useViewContainmentEdgeTypes,
    useViewLineageEdgeTypes,
    useViewRootEntityTypes,
    useViewEntityTypes,
    useViewSchemaIsReady,
} from '@/hooks/useViewSchema'
import type { GraphNode, GraphEdge, EntityTypeDefinition, NodeQuery, NodePage } from '@/providers/GraphDataProvider'
import { BoundedQueue, mapWithConcurrency } from '@/lib/concurrency'
import { classifyGraphFailure, isFailoverFailure } from '@/services/graphRequestFailure'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'
import { useBranchCreatedDelta, committedCreatedUrns, committedCreatedChildUrns } from '@/hooks/useBranchCreatedDelta'
import { useIsDraftMode, useBranchStore } from '@/store/branchStore'
import { normalizeReferenceLayout, deriveEntityScope } from '@/utils/referenceLayout'
import { CHILDREN_PAGE_SIZE } from '@/config/pagination'
import { POLLING_INTERVALS, PROVIDER_RETRY_MAX_ATTEMPTS, withJitter } from '@/config/polling'
import { resetCircuitBreakers } from '@/services/circuitBreaker'
import { useProviderHealthStore } from '@/store/providerHealth'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Page size for loading entities BY TYPE. An open ('all') view loads the
 *  first page of each visible type on arrival and the rest as that type's
 *  column scrolls (`loadMoreFeeds`) — a page size, not a ceiling. */
const PER_TYPE_LIMIT = 200

/** How many type pages one "load more" may read to find a row not held yet. */
const FEED_WALK_MAX_PAGES = 5

/** Where a type feed stands after `page` — the SERVER's position: a client
 *  count of the rows returned is wrong under a draft overlay (see NodePage). */
export function feedAfter(entityTypes: string[], page: NodePage, offset = 0): TypeFeedState {
    // "More" from a page that did not move the position can make no progress.
    return { entityTypes, offset: page.nextOffset, hasMore: page.hasMore && page.nextOffset > offset }
}

/** Where a child pager stands after a page read at `offset` — the SERVER's next
 *  position (an older server without `nextOffset` falls back to counting). A page
 *  that says "more" without moving the position can make no progress, so it
 *  ends the sequence rather than asking for the same page forever. */
export function pagerAfter(
    page: { children: GraphNode[]; hasMore: boolean; nextOffset?: number | null },
    offset: number, direction: 'asc' | 'desc', childCount: number, lastUrn: string | null = null,
): ChildPageState {
    const next = page.nextOffset ?? offset + page.children.length
    return {
        offset: next,
        hasMore: page.hasMore && next > offset,
        direction,
        lastUrn: page.children.length > 0 ? page.children[page.children.length - 1].urn : lastUrn,
        childCount,
    }
}

/**
 * Cap on parallel `loadChildren` calls in flight. A user clicking "expand
 * all" on a 200-node hierarchy must not fan out 200 simultaneous network
 * requests — that is the primary cause of 300–400% FalkorDB CPU spikes
 * documented in docs/audits/. 6 matches a browser's HTTP/1.1 connection
 * cap; tune via VITE_CHILD_LOAD_CONCURRENCY if needed.
 */
/** Page size for top-level (root) entity loading — roots page exactly
 *  like node children so no layer size silently caps the canvas. */
const ROOT_PAGE_SIZE = 200

const CHILD_LOAD_CONCURRENCY = (() => {
    const fromEnv = Number(import.meta.env?.VITE_CHILD_LOAD_CONCURRENCY)
    return Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 6
})()

/**
 * Cap on parallel node batches during the INITIAL load of a view. A curated
 * view loads its assigned entities 100 URNs per request; a 2,000-entity view
 * used to fire all 20 at once, and the backend — which admits ~8 concurrent
 * calls per data source and sheds the rest with 429 — bounced the tail of
 * the view's own burst. Four keeps the browser's per-host connection budget
 * free for the edge fetch and the rest of the app, and is friendlier to slow
 * links than 20 simultaneous uploads of URN lists. Tune via
 * VITE_HYDRATION_CONCURRENCY.
 */
const HYDRATION_CONCURRENCY = (() => {
    const fromEnv = Number(import.meta.env?.VITE_HYDRATION_CONCURRENCY)
    return Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 4
})()

/**
 * Ask `/canvas/bootstrap` for a root page instead of making the three calls
 * (`getNodes`, `getEdgesBetween`, and the aggregated read behind them)
 * separately. On by default; set `VITE_CANVAS_BOOTSTRAP=0` to go back.
 *
 * The three fire together and queue on the browser's six HTTP/1.1
 * connections, so over real network RTT what one request saves is the
 * queueing, not the query time — the backend runs the same engine methods in
 * two concurrent waves. A flag and not a rewrite: the fallback below is the
 * old path unchanged, so a regression is a config flip rather than a revert.
 */
const USE_CANVAS_BOOTSTRAP = import.meta.env?.VITE_CANVAS_BOOTSTRAP !== '0'

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface LoadChildrenOptions {
    /** Server-side sort direction for the child page (default 'asc').
     *  All pages of one parent must load under ONE direction — the canvas
     *  drops partially-loaded children when a layer's direction flips. */
    sortDirection?: 'asc' | 'desc'
}

/**
 * What one child page actually delivered. Returned by `loadChildren` so the
 * CALLER can decide whether to say something about it and in what words — the
 * hook itself stays silent, because GraphCanvas and HierarchyCanvas share it
 * and neither announces a load. Only ContextViewCanvas's two user-initiated
 * call sites (expand, "Load N more") speak.
 */
export interface ChildLoadSummary {
    /** The container's display name — the subject of the message. */
    parentLabel: string
    /** The container's entity type id. */
    parentType?: string
    /** Children this page returned. Zero = nothing more to load. */
    arrived: number
    /** Children already loaded before this page — 0 means this was page 1. */
    offset: number
    /** The container's declared total, when it has one. */
    total?: number
    /** Distinct entity types among this page's children — one means the message can use its schema noun. */
    childTypes: string[]
}

export type HydrationPhase = 'idle' | 'roots' | 'edges' | 'children' | 'complete'

/**
 * Authoritative hydration state machine. ALL terminal canvas UI (empty state,
 * provider overlay, success notifications) derives from this single value so the
 * "genuinely empty" and "failed/loading" cases can never be confused — not
 * even transiently during an auto-retry. Transitions:
 *   loading → ready        (a fetch SUCCEEDED — canvas renders; empty-state
 *                           only if it returned 0 nodes)
 *   loading → warming      (provider is loading its dataset — friendly overlay)
 *   loading → slow         (a request was too slow, was shed, or hit a
 *                           transient gateway/session problem — the provider
 *                           is reachable; calm overlay, keep retrying)
 *   loading → unavailable  (the backend CONFIRMED the provider is unreachable
 *                           — overlay)
 *   loading → error        (code threw while the load ran — a UI library
 *                           reading a property of undefined, a body that was
 *                           not JSON. A bug, named as such: never rendered as
 *                           an outage, never counted by the breaker, retried
 *                           at the same calm cadence as `slow`)
 *   warming/slow/unavailable/error → ready  (a retry succeeded)
 * A retry NEVER leaves a failed state until it actually succeeds, so the
 * overlay stays put and "Start building" can't flash between attempts.
 *
 * `slow` exists because the canvas used to read every failure that was not a
 * warming provider as an outage: a 504 from a slow query, a 429 from the
 * backend shedding the view's own burst, a 401 from a just-expired access
 * token, a client-side timeout on a slow link — all rendered "Graph service
 * is unavailable" over a FalkorDB that was serving fine.
 */
export type HydrationStatus = 'loading' | 'ready' | 'warming' | 'slow' | 'unavailable' | 'error'

/** The four ways a load can end without data. See {@link HydrationStatus}. */
export type HydrationFailure = 'warming' | 'slow' | 'unavailable' | 'error'

/** Thrown by the reference-view load when the view SHOULD have entities
 *  (has assignments / branch-created delta) but every fetch failed — so the
 *  canvas surfaces the failure instead of a false "empty / Start building". */
class HydrationLoadError extends Error {
    constructor(public kind: HydrationFailure) {
        super(
            kind === 'warming' ? 'PROVIDER_LOADING'
                : kind === 'unavailable' ? 'provider-unavailable'
                : kind === 'error' ? 'application-error'
                : 'provider-slow',
        )
        this.name = 'HydrationLoadError'
    }
}

/** Map a rejected load to the state the canvas should show. Anything the
 *  shared classification calls transient (a slow, shed, or session-repair
 *  failure) is `slow`; only a backend-confirmed outage is `unavailable`; an
 *  engine error thrown by code is `error`, never either of those. */
export function toHydrationFailure(err: unknown): HydrationFailure {
    if (err instanceof HydrationLoadError) return err.kind
    const kind = classifyGraphFailure(err)
    return kind === 'transient' ? 'slow' : kind
}

const FAILURE_SEVERITY: Record<HydrationFailure, number> = { slow: 0, error: 1, warming: 2, unavailable: 3 }

/** The state for a load whose batches failed in more than one way: a
 *  confirmed outage outranks a warming provider, which outranks a thrown
 *  error, which outranks slowness. */
export function worstHydrationFailure(errors: readonly unknown[]): HydrationFailure {
    let worst: HydrationFailure = 'slow'
    for (const err of errors) {
        const kind = toHydrationFailure(err)
        if (FAILURE_SEVERITY[kind] > FAILURE_SEVERITY[worst]) worst = kind
    }
    return worst
}

/** A node being replaced retries on the same fast cadence as a store that is
 *  starting up — both are seconds, not an outage — so both are `warming`. But
 *  they are different events and the person watching should be told which:
 *  "starting up" for a cold store, "reconnecting" for a node rotating under a
 *  graph that was already up. Same status, different words. */
const HYDRATION_FAILOVER_MESSAGE =
    'Reconnecting to the graph store — the node holding this graph is restarting.'

const HYDRATION_FAILURE_MESSAGE: Record<HydrationFailure, string> = {
    warming: 'Your graph is starting up…',
    slow: 'Your graph is taking longer than usual to load. Retrying automatically…',
    unavailable: 'The graph provider for this view is unavailable. Your data is safe — this view will load automatically once the provider is back.',
    error: 'This view hit an error while loading. Your data is safe — retrying automatically; a refresh usually clears it.',
}

/** The copy for a failure, given what actually caused it. Only `warming`
 *  splits by cause; every other state reads the same whatever threw. */
function hydrationMessage(failure: HydrationFailure, cause: unknown): string {
    if (failure !== 'warming') return HYDRATION_FAILURE_MESSAGE[failure]
    const causes = Array.isArray(cause) ? cause : [cause]
    return causes.some(isFailoverFailure)
        ? HYDRATION_FAILOVER_MESSAGE
        : HYDRATION_FAILURE_MESSAGE.warming
}

/** True for the states in which a load ended without (complete) data. */
export function isHydrationFailure(status: HydrationStatus): status is HydrationFailure {
    return status === 'warming' || status === 'slow' || status === 'unavailable' || status === 'error'
}

export interface UseGraphHydrationResult {
    /** Load children for a node (empty string = load roots). */
    loadChildren: (parentId: string, options?: LoadChildrenOptions) => Promise<ChildLoadSummary | undefined>
    /**
     * Cancel a pending or in-flight `loadChildren` for the given parent.
     * Queued tasks are dropped silently; in-flight network requests
     * complete but their results are NOT committed to the canvas store.
     * Call this when the user collapses a node mid-load so a slow
     * response doesn't repopulate a collapsed subtree.
     */
    cancelChildLoad: (parentId: string) => void
    /** True when any loading operation is in progress. */
    isLoading: boolean
    /** Set of node IDs currently being loaded. */
    loadingNodes: Set<string>
    /** Set of node IDs that failed to load. */
    failedNodes: Set<string>
    /** Load the next page of top-level (root) entities. */
    loadMoreRoots: () => Promise<void> | void
    /** Count of root entities loaded so far. */
    rootsLoaded: number
    /** Heuristic: the last root page was full, so more likely exist. */
    rootsHaveMore: boolean
    /** Parents the server says have no further pages, each with the childCount
     *  that was said against: honour it only while the parent still has that. */
    exhaustedParents: Map<string, number>
    /** Next page of each named entity feed that has more (a column's end; a
     *  Hierarchy/Graph "more" control). */
    loadMoreFeeds: (feedKeys: string[]) => Promise<void>
    /** Current phase of initial hydration (only meaningful when hydrate=true). */
    hydrationPhase: HydrationPhase
    /** Error message if hydration failed (e.g. provider unavailable/warming). */
    hydrationError: string | null
    /** Authoritative terminal state. Drives the canvas overlay/empty-state so a
     *  failed/warming/loading load is never rendered as an empty graph. */
    hydrationStatus: HydrationStatus
    /** Explicit user-triggered retry for a warming/unavailable provider. */
    retryHydration: () => void
}

interface UseGraphHydrationOptions {
    /**
     * When true, runs the initial hydration effect that loads root nodes + edges
     * on mount / view change. Only ONE component should set this to true
     * (CanvasRouter). All other consumers should leave it false (default) and
     * only use loadChildren.
     */
    hydrate?: boolean
}

// ─── Conversion Utilities (exported for reuse) ──────────────────────────────

/**
 * Convert a backend GraphNode to a canvas LineageNode.
 *
 * Explicit field-by-field map (no `...n` spread) so the canvas store doesn't
 * carry both `displayName` AND `label`, both `entityType` AND `type`, etc.
 * Values pass through verbatim — including empty strings — to preserve
 * wire fidelity. Callers that need a "treat empty as absent" rule should
 * apply it at the consumer, not here.
 */
// Moved to '@/lib/canvasNodeMapper' (pure module) so mapping-only consumers
// don't inherit this hook's heavy transitive imports; re-exported here to
// keep the existing import surface intact.
export { toCanvasNode, toCanvasEdge }

/**
 * PURE: the closed-scope by-URN load set for a reference/Context Model view.
 *
 * A closed-scope view (persisted `entityAssignments`) loads ONLY `assignedUrns`
 * by default — an entity created in the active branch's draft has no persisted
 * assignment yet, so it would never be fetched (never rendered). In a DRAFT,
 * union the branch-created delta (`useBranchCreatedDelta`) into the load set so
 * those entities fetch too. Outside a draft (main/published) — or with an empty
 * delta — the set is unchanged: assigned-only. This is the mandatory regression
 * guard: a view with NO branch-created entities loads EXACTLY as before.
 */
export function closedScopeLoadUrns(
    assignedUrns: Set<string>,
    delta: Set<string>,
    isDraft: boolean,
): string[] {
    if (!isDraft || delta.size === 0) return [...assignedUrns]
    return [...new Set([...assignedUrns, ...delta])]
}

/**
 * Compute the "view-scoped root types" for a reference/context view.
 *
 * A type is a VIEW ROOT if none of its canBeContainedBy parents appear in
 * the view's visibleEntityTypes set.
 */
export function computeViewScopedRoots(
    visibleTypes: string[],
    schemaEntityTypes: EntityTypeDefinition[],
    globalRoots: string[],
): string[] {
    if (visibleTypes.length === 0) return globalRoots

    const visibleSet = new Set(visibleTypes)

    const roots = visibleTypes.filter(typeId => {
        const et = schemaEntityTypes.find(e => e.id === typeId)
        if (!et) return true
        const parents = et.hierarchy?.canBeContainedBy ?? []
        return parents.every(parentType => !visibleSet.has(parentType))
    })

    if (roots.length > 0) return roots

    const globalOverlap = globalRoots.filter(r => visibleSet.has(r))
    return globalOverlap.length > 0 ? globalOverlap : [visibleTypes[0]]
}

// ─── The Hook ───────────────────────────────────────────────────────────────

export function useGraphHydration(options?: UseGraphHydrationOptions): UseGraphHydrationResult {
    const enableHydration = options?.hydrate ?? false

    const provider = useGraphProvider()
    const { providerVersion, workspaceId: providerWsId, dataSourceId: providerDsId } = useGraphProviderContext()

    // Force the client-side circuit breakers closed so a re-attempt actually
    // probes the provider. Without this, an OPEN breaker (it opens for ~15s
    // after failures, longer with a Retry-After) makes every retry throw
    // "circuit open" WITHOUT a network call — which is exactly why clicking
    // "Retry now" did nothing until a full page refresh (which builds a fresh
    // provider + breaker). Same singletons the provider uses. Resets EVERY
    // endpoint class for this scope, not just 'default': hydration also
    // fetches through 'children' (/edges/between, /children-with-edges), and
    // a stale open breaker on that class would fast-fail the recovery retry.
    const forceReprobe = useCallback(() => {
        resetCircuitBreakers(providerWsId ?? undefined, providerDsId ?? undefined)
    }, [providerWsId, providerDsId])
    const containmentEdgeTypes = useViewContainmentEdgeTypes()
    const lineageEdgeTypes = useViewLineageEdgeTypes()
    const rootEntityTypes = useViewRootEntityTypes()
    const schemaEntityTypes = useViewEntityTypes()
    const isSchemaReady = useViewSchemaIsReady()
    const activeView = useActiveView()
    // Branch-created delta: URNs created in the active branch's draft (see
    // useBranchCreatedDelta.ts). Unioned into the closed-scope by-URN load set
    // below, ONLY in a draft, so freshly-created entities fetch even before
    // they land in the view's persisted `entityAssignments`.
    const branchCreatedDelta = useBranchCreatedDelta()
    const isDraft = useIsDraftMode()
    // The COMMITTED-in-branch half of the delta comes from `activeChangeSet`,
    // which is fetched asynchronously (CanvasVersioningBar's diff-vs-main query)
    // and is still null on the render where this hook's mount effect first
    // fires — so a real page reload would otherwise permanently miss
    // previously-committed created entities (the closure below never re-runs).
    // Re-derive a content-stable key from JUST the committed portion (sorted,
    // joined) and use it as an extra effect dependency so hydration re-runs
    // once when that async diff resolves. Deliberately NOT keyed on the
    // live-staged portion: a staged (unsaved) create is already rendered
    // optimistically (`isPending: 'create'` in the canvas store, see
    // loadChildren above) and re-hydrating would clear+refetch the whole
    // canvas, wiping that not-yet-saved node (it doesn't exist server-side
    // yet, so the refetch wouldn't bring it back).
    const activeChangeSet = useBranchStore((s) => s.activeChangeSet)
    const committedDeltaKey = useMemo(
        () => (isDraft ? [...committedCreatedUrns(activeChangeSet)].sort().join('|') : ''),
        [isDraft, activeChangeSet],
    )
    // Content-stable keys for the hydration effect deps: the schema store
    // rebuilds these arrays on every reload (token refresh, permission poll
    // tick), and an identity-churned-but-identical array re-triggers the
    // effect — whose cleanup resets initializedKeyRef, re-running the full
    // clear + chunked getNodes/getEdgesBetween burst. Keying on content
    // means only a REAL type-set change re-hydrates. Accepted tradeoff: a
    // schema edit that changes only hierarchy metadata (not the id set)
    // won't re-hydrate — real ontology swaps change providerVersion or the
    // id set. The effect body still reads the closure arrays; their content
    // matches the key by construction.
    const rootTypesKey = useMemo(() => [...rootEntityTypes].sort().join('|'), [rootEntityTypes])
    const schemaTypesKey = useMemo(
        () => schemaEntityTypes.map(et => et.id).sort().join('|'),
        [schemaEntityTypes],
    )

    const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())
    const [failedNodes, setFailedNodes] = useState<Set<string>>(new Set())
    const [hydrationPhase, setHydrationPhase] = useState<HydrationPhase>('idle')
    // hydrationError is the human message for the overlay; hydrationStatus is the
    // authoritative state that ALL terminal UI derives from (see HydrationStatus).
    const [hydrationError, setHydrationError] = useState<string | null>(null)
    const [hydrationStatus, setHydrationStatus] = useState<HydrationStatus>('loading')
    // Bumped to re-run the hydration effect for a bounded/persistent auto-retry
    // while the provider is warming up / down (see the retry effect below).
    const [retryEpoch, setRetryEpoch] = useState(0)
    const retryCountRef = useRef(0)
    // Last (provider, view) key the retry budget was reset for — so a genuinely
    // NEW view starts fresh at 'loading' with a full retry budget, while a retry
    // of the SAME view keeps counting.
    const lastInitKeyRef = useRef<string | null>(null)

    // Prevent infinite retries when API returns [] for roots
    const rootsAttemptedForRef = useRef<string | null>(null)

    // ── Root pagination ──────────────────────────────────────────────
    // Layer roots page in ROOT_PAGE_SIZE batches, exactly like node
    // children — the previous single fetch of 200 was the last silent
    // cap on the canvas ("never lose data" invariant). Offset tracked
    // in a ref (read at click time); count mirrored to state for the
    // status chip; have-more uses the full-page heuristic shared with
    // the truncation banners.
    const rootsLoadedRef = useRef(0)
    const [rootsLoaded, setRootsLoaded] = useState(0)
    const [rootsHaveMore, setRootsHaveMore] = useState(false)

    // Track (provider, viewId) so reference views reload when the active view changes.
    const initializedKeyRef = useRef<string | null>(null)

    // Bounded queue for child-load tasks. Caps parallel `loadChildren`
    // calls at CHILD_LOAD_CONCURRENCY and exposes per-key cancellation
    // (used by the canvas when a user collapses a node mid-load).
    const queueRef = useRef<BoundedQueue>(new BoundedQueue(CHILD_LOAD_CONCURRENCY))

    // Reset when provider changes (e.g. workspace/datasource switch)
    useEffect(() => {
        rootsAttemptedForRef.current = null
        // (Root pagination STATE resets in the root-load branch itself —
        // setState here would run synchronously inside this effect.)
        rootsLoadedRef.current = 0
        // Also reset the hydration guard so re-hydration happens on provider change
        initializedKeyRef.current = null
        // Cancel everything queued under the previous provider
        queueRef.current.cancelAll()
    }, [provider])

    // ─── Initial Hydration Effect (only when hydrate=true) ──────────────
    //
    // This effect ONLY fires in CanvasRouter. Individual canvas components
    // (HierarchyCanvas, ContextViewCanvas, etc.) call useGraphHydration()
    // without { hydrate: true }, so they skip this entirely and only use
    // loadChildren.

    useEffect(() => {
        if (!enableHydration) return
        // Inside ViewExecutionProvider, isSchemaReady is always true because
        // the provider gates children behind schema readiness. Outside (legacy),
        // it reflects the global schema loading state.
        if (!isSchemaReady) return

        const layoutType = activeView?.layout.type ?? 'graph'
        const isReferenceView = layoutType === 'reference'

        // Key on providerVersion + view ID + layout type. The provider IS the
        // scope (its wsId/dsId are fixed at construction), so we don't need to
        // include workspace/datasource IDs in the key — changing the view's
        // scope changes the provider, which changes providerVersion.
        const initKey = `${providerVersion}:${activeView?.id ?? 'default'}:${layoutType}`

        if (initializedKeyRef.current === initKey) return
        initializedKeyRef.current = initKey

        // A genuinely NEW view (new initKey) resets the retry budget.
        const isFreshView = lastInitKeyRef.current !== initKey
        if (isFreshView) {
            lastInitKeyRef.current = initKey
            retryCountRef.current = 0
        }
        // Any ACTIVE load — a fresh view OR a re-fetch of the same view (deps
        // churned) — must show 'loading', NOT 'ready'. Otherwise the canvas is
        // cleared (setGraph([],[]) below) while status is still 'ready' from the
        // previous success, and the empty-state gate (status==='ready' &&
        // nodes===0) flashes "Start building" in the reload gap. A RETRY of a
        // FAILED load is the one exception: keep the warming/unavailable overlay
        // (retryCountRef>0 marks it) so it doesn't blink either. So the empty
        // state is reachable ONLY from a SETTLED successful load (markReady).
        const isRetry = retryCountRef.current > 0
        if (!isRetry) {
            setHydrationStatus('loading')
            setHydrationError(null)
        }

        // Mark this view as (re)loading synchronously, before the async fetch.
        // Otherwise a stale 'complete' from the previous view lingers through
        // the switch, and anything gated on "hydration finished" (the ghost
        // shimmer, the staged-draft restore) would fire against the
        // about-to-be-cleared canvas.
        setHydrationPhase('roots')

        const { setGraph } = useCanvasStore.getState()

        // The single SUCCESS terminal: a fetch returned (with data or genuinely
        // empty). Clears any error and moves to 'ready' — the ONLY state in
        // which the canvas may show "Start building". Called from every
        // successful path so no success can leave a stale error/overlay up.
        const markReady = () => {
            setHydrationError(null)
            setHydrationStatus('ready')
            setHydrationPhase('complete')
        }

        // A load that rendered SOME of the view but not all of it: the nodes
        // that arrived stay on screen, the status records why the rest did
        // not, and the retry loop keeps trying for the remainder. Not 'ready'
        // — 'ready' means complete — and not the blocking overlay either: the
        // canvas has data, so CanvasRouter shows a pill over it instead.
        const markPartial = (failure: HydrationFailure, cause?: unknown) => {
            setHydrationStatus(failure)
            setHydrationError(hydrationMessage(failure, cause))
            setHydrationPhase('complete')
        }

        // Clear the canvas ONLY for a genuinely new view. A reload of the SAME
        // view — a retry after a failed or partial load, a schema-deps churn —
        // keeps what is on screen until the new load lands (`setGraph` below
        // replaces atomically), so a slow provider never wipes a canvas the
        // user is reading; the overlay/pill say a refresh is in progress. The
        // empty-state gate is status==='ready' && nodes===0, so kept nodes can
        // never leak into "Start building". Do NOT clear hydrationError/status
        // on a RETRY either — that's what caused the overlay to blink to "Start
        // building" between attempts; a retry only clears them by SUCCEEDING
        // (markReady) below.
        if (isFreshView) setGraph([], [])
        // How this load writes the graph. A genuinely NEW view replaces the canvas. A re-run of the
        // SAME view — after a save changed the draft's diff, a retry, an ontology refresh — MERGES:
        // replacing threw away every child page the user had expanded, so saved children vanished
        // after each save until their parent was collapsed and re-opened. (Unsaved work survives
        // either way: every graph write overlays the pending edits, see stagedOverlay.)
        const writeGraph = isFreshView
            ? setGraph
            : (n: LineageNode[], e: LineageEdge[]) => useCanvasStore.getState().addGraph(n, e)
        // Fresh attempt → fresh integrity state; failures from the previous
        // attempt would otherwise keep the incomplete-canvas banner/pill up
        // after a clean reload.
        useCanvasStore.getState().clearEdgeFetchFailures()
        useCanvasStore.getState().setEdgesTruncated(false)
        useCanvasStore.getState().clearNodeFetchFailures()

        const controller = new AbortController()

        const hydrate = async () => {
            try {
                if (isReferenceView) {
                    // ── Reference / Context View ────────────────────────
                    // Strategy: load ONLY the entities that are relevant to this view.
                    //
                    // If the view has canonical layer assignments, load those specific
                    // entities by URN. This matches exactly what the user configured in
                    // the wizard/canvas (both now write referenceLayout.assignments).
                    //
                    // If no assignments exist (new/empty view), fall back to loading
                    // by entity type so the user has something to work with.

                    const viewTypes = activeView?.content?.visibleEntityTypes ?? []

                    // Collect all assigned root URNs from the canonical assignment map.
                    const normLayout = normalizeReferenceLayout(activeView?.layout?.referenceLayout)
                    const assignedUrns = new Set<string>()
                    for (const [urn, entry] of Object.entries(normLayout.assignments)) {
                        if (entry?.layerId) assignedUrns.add(urn)
                    }

                    // Respect the view's entityScope (curated is the default once assignments exist).
                    // A CURATED view loads strictly by its assigned URNs (∪ this branch's created
                    // delta); an OPEN ('all') view loads type-based, so assignments only PLACE
                    // entities into layers, never hide them. Gating on the SCOPE — not merely "has
                    // any assignment" — is what stops an open view that happens to carry a few
                    // assignments from collapsing to just those (the entities-vanish bug). Aligns
                    // hydration with useLayerAssignment's deriveEntityScope gate.
                    const loadByUrn = deriveEntityScope(activeView?.content, normLayout) === 'curated'

                    setHydrationPhase('roots')

                    let allNodes: GraphNode[] = []
                    // Count of branch-created URNs unioned into the assigned set below
                    // (0 outside a draft / with an empty delta) — logging only.
                    let deltaLoadedCount = 0

                    // Track every node fetch that FAILED (vs legitimately returned
                    // []). A failed batch is tolerated when others succeeded, but
                    // must not silently turn a TOTAL failure into "empty graph"
                    // — that's what rendered a warming provider as "Start building".
                    // Batches run through a small pool (HYDRATION_CONCURRENCY), not
                    // all at once: the backend sheds the tail of an oversized burst
                    // with 429, and a shed batch is a failed batch.
                    const batchErrors: unknown[] = []
                    // Assigned entities inside the batches that failed — what a
                    // partial load is missing, by count, for the pill.
                    let missingEntities = 0
                    const loadNodeBatches = async (queries: NodeQuery[]): Promise<GraphNode[]> => {
                        const settled = await mapWithConcurrency(
                            queries, HYDRATION_CONCURRENCY, q => provider.getNodes(q),
                        )
                        const loaded: GraphNode[] = []
                        settled.forEach((outcome, i) => {
                            if (outcome.status === 'fulfilled') {
                                loaded.push(...outcome.value)
                            } else {
                                batchErrors.push(outcome.reason)
                                missingEntities += queries[i].urns?.length ?? 0
                            }
                        })
                        return loaded
                    }
                    const totalFailure = () => new HydrationLoadError(worstHydrationFailure(batchErrors))
                    // Where each open-scope type feed stands after its first page —
                    // seeded once the graph is set (setGraph clears feeds).
                    const typeFeedSeeds: Array<[string, TypeFeedState]> = []

                    if (loadByUrn) {
                        // ── Assignment-driven loading (curated scope) ──
                        // Load the specific entities assigned to layers by URN,
                        // UNIONED (in a draft) with entities created in this
                        // branch — they have no persisted entityAssignment yet
                        // and would otherwise never be fetched. Empty delta /
                        // non-draft ⇒ assigned-only, identical to before.
                        const urnBatches: string[][] = []
                        // Children the branch created are reached through their parents (see
                        // committedCreatedChildUrns); only the branch's new ROOTS load flat here.
                        const createdChildren = committedCreatedChildUrns(activeChangeSet, containmentEdgeTypes)
                        const createdRoots = new Set([...branchCreatedDelta].filter((u) => !createdChildren.has(u)))
                        const urnArray = closedScopeLoadUrns(assignedUrns, createdRoots, isDraft)
                        deltaLoadedCount = urnArray.length - assignedUrns.size
                        // Batch URNs to avoid overly large queries
                        for (let i = 0; i < urnArray.length; i += 100) {
                            urnBatches.push(urnArray.slice(i, i + 100))
                        }

                        allNodes = await loadNodeBatches(
                            urnBatches.map(batch => ({ urns: batch as any[], limit: batch.length })),
                        )
                        if (controller.signal.aborted) return

                        // Children are NOT prefetched. Top-level assigned entities
                        // render collapsed; expanding a parent fires the lazy loader
                        // (loadChildren below) for its first CHILDREN_PAGE_SIZE page,
                        // and the LoadMoreItem row pages through the rest on click.
                    } else {
                        // ── Type-based loading (empty/new views) ──
                        // No assignments yet — load by entity type so the view has data
                        // for the user to start assigning in the wizard.
                        // An EMPTY result is a terminal state, not a stall: mark hydration
                        // complete so the canvas leaves its ghost-loading UI and renders
                        // its real empty states (blank models legitimately start at zero).
                        const rootTypes = computeViewScopedRoots(viewTypes, schemaEntityTypes, rootEntityTypes)
                        if (rootTypes.length === 0 && assignedUrns.size === 0) {
                            markReady()
                            return
                        }

                        // Each type is its own lossless feed: its first page lands
                        // here and the rest as its column scrolls (loadMoreFeeds).
                        // PER_TYPE_LIMIT is a page size, not a ceiling.
                        const loadTypePages = async (types: string[]): Promise<GraphNode[]> => {
                            const settled = await mapWithConcurrency(
                                types, HYDRATION_CONCURRENCY,
                                et => provider.getNodesPage({ entityTypes: [et], limit: PER_TYPE_LIMIT }),
                            )
                            const out: GraphNode[] = []
                            settled.forEach((outcome, i) => {
                                if (outcome.status !== 'fulfilled') {
                                    batchErrors.push(outcome.reason)
                                    return
                                }
                                out.push(...outcome.value.nodes)
                                typeFeedSeeds.push([types[i], feedAfter([types[i]], outcome.value)])
                            })
                            return out
                        }

                        allNodes = await loadTypePages(rootTypes)
                        if (controller.signal.aborted) return

                        // Also load remaining visible types (non-root layers) — as
                        // before, only when the view's roots produced something.
                        if (allNodes.length > 0) {
                            setHydrationPhase('children')
                            const loadedRootTypes = new Set(allNodes.map(n => n.entityType))
                            const remainingTypes = viewTypes.filter(t => !loadedRootTypes.has(t))
                            if (remainingTypes.length > 0) {
                                const childNodes = await loadTypePages(remainingTypes)
                                if (controller.signal.aborted) return
                                allNodes = [...allNodes, ...childNodes]
                            }
                        }

                        // Explicit placements load by URN in EVERY scope. Type pages
                        // are ordered by name, so an entity placed by hand — or a
                        // column's anchor — can sort far past the first page and would
                        // otherwise never be fetched: its column would come up empty.
                        const loadedUrns = new Set(allNodes.map(n => n.urn))
                        const unplaced = [...assignedUrns].filter(u => !loadedUrns.has(u))
                        if (unplaced.length > 0) {
                            const batches: string[][] = []
                            for (let i = 0; i < unplaced.length; i += 100) batches.push(unplaced.slice(i, i + 100))
                            const placed = await loadNodeBatches(
                                batches.map(batch => ({ urns: batch, limit: batch.length })),
                            )
                            if (controller.signal.aborted) return
                            allNodes = [...allNodes, ...placed]
                        }
                    }

                    // ── Anchored columns ──────────────────────────────
                    // A column anchored to an entity renders that entity's
                    // CHILDREN as its rows. Curated hydration loads assigned
                    // URNs and deliberately does not prefetch children, so
                    // without this the column comes up empty until someone
                    // expands the anchor — which an anchored column never draws.
                    // Fetched per anchor (not per column) so two columns on the
                    // same entity cost one request.
                    // ONE page per anchor, whatever its size. The column draws
                    // these as its rows and carries its own "Load more" for the
                    // rest, so a 5000-child container costs the same first page
                    // as a 5-child one and the user pulls what they need.
                    const declaredAnchors = new Set(
                        normLayout.layers.map(l => l.anchorUrn).filter((u): u is string => !!u),
                    )
                    const anchorUrns = allNodes
                        .filter(n => declaredAnchors.has(n.urn) && (n.childCount ?? 0) > 0)
                        .map(n => n.urn)
                    // Where each anchor's first page leaves its pager — seeded once
                    // the graph is set (setGraph clears pagers), so the column's
                    // first scroll continues at page 2 instead of re-fetching page 1.
                    const anchorPagers: Array<[string, ChildPageState]> = []
                    // The prefetch's containment edges go into the FIRST graph write:
                    // without them an anchored column can't see its children until
                    // the edge fetch lands, and shows a "load more" row meanwhile.
                    const anchorEdges: GraphEdge[] = []
                    if (anchorUrns.length > 0) {
                        const loaded = new Set(allNodes.map(n => n.urn))
                        const countOf = new Map(allNodes.map(n => [n.urn, n.childCount ?? 0]))
                        const settled = await mapWithConcurrency(
                            anchorUrns, HYDRATION_CONCURRENCY,
                            urn => provider.getChildrenWithEdges(urn, {
                                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                                limit: CHILDREN_PAGE_SIZE,
                                // Edges among everything loaded are fetched below.
                                includeLineageEdges: false,
                            }),
                        )
                        if (controller.signal.aborted) return
                        settled.forEach((outcome, i) => {
                            if (outcome.status !== 'fulfilled') {
                                // Left to the COLUMN, not the view: with no pager
                                // seeded, its load-more row asks for the first page
                                // again when it comes into view, and says so with a
                                // Retry if that fails too. As a view-level failure
                                // it re-ran every query and replaced the whole graph
                                // on each retry — forever, for a failure that stays.
                                console.warn(
                                    `[useGraphHydration] children of anchored column ${anchorUrns[i]} failed to load — the column retries them`,
                                    outcome.reason,
                                )
                                return
                            }
                            const page = outcome.value
                            for (const child of page.children) {
                                if (loaded.has(child.urn)) continue
                                loaded.add(child.urn)
                                allNodes.push(child)
                            }
                            anchorEdges.push(...page.containmentEdges)
                            if (page.children.length > 0) {
                                anchorPagers.push([anchorUrns[i], pagerAfter(page, 0, 'asc', countOf.get(anchorUrns[i]) ?? 0)])
                            }
                        })
                    }

                    if (allNodes.length === 0) {
                        // Distinguish "failed to load" from "genuinely empty" by the
                        // ONLY reliable signal: did a fetch error? A healthy provider
                        // returns [] with no error for a truly empty view; a
                        // down/warming/overloaded provider throws. If ANY fetch errored
                        // we must surface the failure (overlay + auto-retry) — never a
                        // false "No entities yet / Start building" over data that may
                        // exist. (Assignments/draft-state are NOT part of this decision
                        // — a Published view with no assignments still must not lie
                        // "empty" when the provider is down.)
                        if (batchErrors.length > 0) throw totalFailure()
                        markReady()   // empty view — terminal, not a stall
                        return
                    }
                    const partial = batchErrors.length > 0
                    if (partial) {
                        // Partial: render what arrived rather than nothing, but
                        // never pretend it is complete — the store records the
                        // gap for the pill, the status stays failed so the retry
                        // loop keeps going, and the first error is logged so the
                        // gap is diagnosable.
                        useCanvasStore.getState().noteNodeFetchFailure(batchErrors.length, missingEntities)
                        console.warn(
                            `[useGraphHydration] ${batchErrors.length} node batch(es) failed after retries — rendering the ${allNodes.length} entities that loaded; retrying for the rest`,
                            batchErrors[0],
                        )
                    }

                    // Show nodes immediately, then fetch edges
                    writeGraph(
                        allNodes.map(n => toCanvasNode(n)),
                        anchorEdges.map(e => toCanvasEdge(e)),
                    )
                    // setGraph clears pagers and feeds; both writes re-seed them —
                    // in ONE store update (56 separate ones were 56 full renders).
                    const seedAnchorPagers = () => {
                        useCanvasStore.getState().seedPositions(
                            Object.fromEntries(anchorPagers), Object.fromEntries(typeFeedSeeds),
                        )
                    }
                    seedAnchorPagers()

                    // Fetch edges between all loaded nodes. Pass the backend
                    // hard maximum so the user's assigned set is never
                    // truncated at the 50k default on large graphs.
                    setHydrationPhase('edges')
                    const allUrns = allNodes.map(n => n.urn)
                    const allEdges = await provider.getEdgesBetween(allUrns, undefined, 200_000).catch((err: unknown) => {
                        // Nodes still render (graceful), but record the
                        // failure so the canvas can say edges are missing.
                        useCanvasStore.getState().noteEdgeFetchFailure(err instanceof Error ? err.message : undefined)
                        return [] as GraphEdge[]
                    })
                    if (controller.signal.aborted) return
                    // /edges/between returns a bare list with no truncated
                    // flag — a result exactly at the request limit almost
                    // certainly hit the server-side cap. (A response header
                    // would be lost on GraphCache hits, so this length
                    // heuristic is the compatible signal.)
                    if (allEdges.length >= 200_000) {
                        useCanvasStore.getState().setEdgesTruncated(true)
                    }

                    // Replace with complete dataset atomically
                    writeGraph(
                        allNodes.map(n => toCanvasNode(n)),
                        allEdges.map(e => toCanvasEdge(e)),
                    )
                    seedAnchorPagers()

                    console.log(`[useGraphHydration] Reference view: loaded ${allNodes.length} nodes (${assignedUrns.size} assigned, ${deltaLoadedCount} branch-created), ${allEdges.length} edges`)
                    if (partial) {
                        markPartial(worstHydrationFailure(batchErrors), batchErrors)
                        return
                    }
                } else {
                    // ── Hierarchy / Graph view ──────────────────────────
                    // Mirrors old App.tsx behavior: load roots, then first-level
                    // children for each root, then all edges between them.
                    // This ensures HierarchyCanvas has containment edges to
                    // build its tree immediately.
                    const typesToLoad = rootEntityTypes.length > 0
                        ? rootEntityTypes
                        : schemaEntityTypes.map(et => et.id)

                    if (typesToLoad.length === 0) {
                        markReady()   // nothing to load — terminal
                        return
                    }

                    // Step 1: Fetch root nodes — the first page of the ROOTS feed.
                    // A "more" control continues it (loadMoreFeeds); PER_TYPE_LIMIT
                    // is a page size, not a ceiling.
                    setHydrationPhase('roots')
                    const rootPage = await provider.getNodesPage({
                        entityTypes: typesToLoad,
                        limit: PER_TYPE_LIMIT,
                    })
                    const rootNodes = rootPage.nodes
                    if (controller.signal.aborted) return
                    if (rootNodes.length === 0) {
                        markReady()   // empty graph — terminal, not a stall
                        return
                    }

                    // Where the feeds and each root's child pager stand after this
                    // load; setGraph clears both, so every graph write re-seeds them.
                    const feedSeeds: Array<[string, TypeFeedState]> = [
                        ['__roots__', feedAfter(typesToLoad, rootPage)],
                    ]
                    const pagerSeeds: Array<[string, ChildPageState]> = []
                    // ONE store update however many roots and feeds there are.
                    const seedPositions = () => {
                        useCanvasStore.getState().seedPositions(
                            Object.fromEntries(pagerSeeds), Object.fromEntries(feedSeeds),
                        )
                    }

                    // Show roots immediately
                    writeGraph(
                        rootNodes.map(n => toCanvasNode(n, { randomPosition: true })),
                        [],
                    )
                    seedPositions()

                    // Step 2: the first page of each root's children. Bounded: one
                    // request per root fired all at once is a burst the backend sheds
                    // with 429s. Paged: each root's pager continues at page 2 when it
                    // is expanded. Honest: a failed page is COUNTED, never read as "no
                    // children" (expanding that root still loads them).
                    setHydrationPhase('children')
                    const parents = rootNodes.filter(r => (r.childCount ?? 1) > 0)
                    const settledChildren = await mapWithConcurrency(
                        parents, HYDRATION_CONCURRENCY,
                        root => provider.getChildrenWithEdges(root.urn, {
                            edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                            limit: CHILDREN_PAGE_SIZE,
                            // Edges among everything loaded are fetched in step 4.
                            includeLineageEdges: false,
                        }),
                    )
                    if (controller.signal.aborted) return
                    const allChildren: GraphNode[] = []
                    let failedPages = 0
                    settledChildren.forEach((outcome, i) => {
                        if (outcome.status !== 'fulfilled') {
                            failedPages += 1
                            return
                        }
                        const page = outcome.value
                        allChildren.push(...page.children)
                        if (page.children.length > 0) {
                            pagerSeeds.push([parents[i].urn, pagerAfter(page, 0, 'asc', parents[i].childCount ?? 0)])
                        }
                    })
                    if (failedPages > 0) {
                        useCanvasStore.getState().noteNodeFetchFailure(failedPages, 0)
                        console.warn(
                            `[useGraphHydration] first children page failed for ${failedPages} of ${parents.length} roots — expanding them retries`,
                        )
                    }

                    // Step 3: Fetch orphaned nodes of child types (nodes without
                    // a parent in our root set, e.g. dataPlatforms without a domain)
                    // — the first page of the ORPHANS feed.
                    const entityTypeHierarchy = schemaEntityTypes
                    const childTypes = new Set<string>()
                    for (const rootType of typesToLoad) {
                        const et = entityTypeHierarchy.find(e => e.id === rootType)
                        et?.hierarchy?.canContain?.forEach((t: string) => childTypes.add(t))
                    }

                    let orphanNodes: GraphNode[] = []
                    if (childTypes.size > 0) {
                        const orphanTypes = [...childTypes]
                        let childTypeNodes: GraphNode[] = []
                        try {
                            const orphanPage = await provider.getNodesPage({
                                entityTypes: orphanTypes,
                                limit: PER_TYPE_LIMIT,
                            })
                            childTypeNodes = orphanPage.nodes
                            feedSeeds.push(['__orphans__', feedAfter(orphanTypes, orphanPage)])
                        } catch (err) {
                            useCanvasStore.getState().noteNodeFetchFailure(1, 0)
                            console.warn('[useGraphHydration] orphan page failed to load', err)
                        }
                        if (controller.signal.aborted) return

                        // Filter out nodes we already have
                        const knownUrns = new Set([
                            ...rootNodes.map(n => n.urn),
                            ...allChildren.map(n => n.urn),
                        ])
                        orphanNodes = childTypeNodes.filter(n => !knownUrns.has(n.urn))
                    }

                    // Deduplicate all nodes
                    const nodeMap = new Map<string, GraphNode>()
                    for (const n of [...rootNodes, ...allChildren, ...orphanNodes]) {
                        nodeMap.set(n.urn, n)
                    }
                    const uniqueNodes = Array.from(nodeMap.values())

                    // Step 4: Fetch edges between ALL loaded nodes
                    setHydrationPhase('edges')
                    const allUrns = uniqueNodes.map(n => n.urn)
                    const allEdges = await provider.getEdgesBetween(allUrns).catch((err: unknown) => {
                        useCanvasStore.getState().noteEdgeFetchFailure(err instanceof Error ? err.message : undefined)
                        return [] as GraphEdge[]
                    })
                    if (controller.signal.aborted) return
                    if (allEdges.length >= 50_000) {
                        useCanvasStore.getState().setEdgesTruncated(true)
                    }

                    console.log(`[useGraphHydration] Loaded ${uniqueNodes.length} nodes (${rootNodes.length} roots, ${allChildren.length} children, ${orphanNodes.length} orphans), ${allEdges.length} edges`)

                    writeGraph(
                        uniqueNodes.map(n => toCanvasNode(n, { randomPosition: true })),
                        allEdges.map(e => toCanvasEdge(e)),
                    )
                    seedPositions()
                }

                markReady()
            } catch (err) {
                if (!controller.signal.aborted) {
                    // "Warming" = the provider is loading its dataset (restart);
                    // "slow" = a request was too slow / shed / hit a transient
                    // gateway or session problem — both auto-retried with a
                    // friendly tone. Only a backend-CONFIRMED outage (503
                    // PROVIDER_UNAVAILABLE, or no backend at all) is
                    // "unavailable"; a 504, 429, 502, 401 or client timeout
                    // never is — see services/graphRequestFailure.
                    const failure = toHydrationFailure(err)
                    if (failure === 'unavailable') {
                        console.error('[useGraphHydration] Hydration failed — provider unavailable:', err)
                    } else if (failure === 'error') {
                        // A bug, not the provider: logged at error level with
                        // its stack so it is found, and named as such in the
                        // UI so nobody chases the graph service for it.
                        console.error('[useGraphHydration] Hydration failed — code threw during the load (not a provider problem):', err)
                    } else {
                        console.warn(`[useGraphHydration] Hydration deferred (${failure}) — retrying:`, err)
                    }
                    // Single failure terminal: set the authoritative status. The
                    // overlay + auto-retry derive from this; it stays until a retry
                    // SUCCEEDS (markReady), so "Start building" can't flash between
                    // attempts. Phase → complete so the loading ghosts stop.
                    setHydrationStatus(failure)
                    setHydrationError(hydrationMessage(failure, err))
                    setHydrationPhase('complete')
                }
            }
        }

        hydrate()
        return () => {
            controller.abort()
            // Reset the guard so the next effect run (same initKey, new deps snapshot)
            // can re-start hydration. Without this, a mid-flight abort (e.g. background
            // schema refresh changing rootEntityTypes) leaves initializedKeyRef permanently
            // set to initKey, causing the subsequent run to return early and the canvas
            // to stay empty — most visible on cross-workspace view navigation.
            if (initializedKeyRef.current === initKey) {
                initializedKeyRef.current = null
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enableHydration, provider, providerVersion, activeView?.id, activeView?.layout.type, rootTypesKey, schemaTypesKey, isSchemaReady, committedDeltaKey, retryEpoch])

    // Explicit, user-triggered retry (the overlay's "Retry" button, or when a
    // background tab is brought back to the foreground). Re-arms a fresh round
    // of auto-retries. Kept stable so the overlay button identity doesn't churn.
    const retryHydration = useCallback(() => {
        forceReprobe()                     // close the breaker so this actually hits the network
        retryCountRef.current = 0
        initializedKeyRef.current = null
        setRetryEpoch(e => e + 1)
    }, [forceReprobe])

    // Auto-retry while the provider is warming/slow/unavailable — but SCALE-SAFELY:
    //  • a configurable, deliberately-unhurried interval (POLLING_INTERVALS.
    //    providerRetry, default 10s), NOT a tight 2-3s loop that would multiply
    //    load across every affected user with no faster recovery;
    //  • JITTERED, so 100s of users hitting the same outage don't retry in
    //    lockstep (thundering herd);
    //  • NEVER stops. 'warming' means the backend answered 503 + Retry-After
    //    ("I exist, I'm loading the dataset") — a pod rotation + AOF replay
    //    legitimately takes minutes, so warming polls stay on the fast
    //    cadence indefinitely. 'unavailable' (hard down) and 'slow' (a heavy
    //    view timing out, a shed burst) get PROVIDER_RETRY_MAX_ATTEMPTS fast
    //    attempts, then degrade to the slow background cadence
    //    (providerRetrySlow, default 60s) — a completed node rotation must
    //    self-heal without a user click or page reload, and a persistently
    //    slow view must not re-run its heavy query every 10s forever;
    //  • PAUSED entirely while the tab is hidden (no background-tab hammering).
    // A retry NEVER clears the status/overlay — only a SUCCESSFUL load
    // (markReady) flips to 'ready', so the overlay can't blink to "Start
    // building" between attempts. retryEpoch is a dep so this re-evaluates after
    // each attempt and schedules the next while still failed.
    useEffect(() => {
        if (!enableHydration) return
        if (!isHydrationFailure(hydrationStatus)) {
            retryCountRef.current = 0
            return
        }
        if (typeof document !== 'undefined' && document.hidden) return
        const exhausted = hydrationStatus !== 'warming'
            && retryCountRef.current >= PROVIDER_RETRY_MAX_ATTEMPTS
        const attempt = retryCountRef.current + 1
        const delay = withJitter(exhausted
            ? POLLING_INTERVALS.providerRetrySlow
            : POLLING_INTERVALS.providerRetry)
        const t = setTimeout(() => {
            forceReprobe()                     // close the breaker so the retry actually probes
            retryCountRef.current = attempt
            initializedKeyRef.current = null   // re-arm the hydration effect
            setRetryEpoch(e => e + 1)          // re-run; status/overlay stay until success
        }, delay)
        return () => clearTimeout(t)
    }, [enableHydration, hydrationStatus, retryEpoch, forceReprobe])

    // Resume retrying the moment a hidden tab returns to the foreground (the
    // auto-retry above pauses while hidden), so a user coming back to a warming
    // canvas gets an immediate attempt instead of waiting out the interval.
    useEffect(() => {
        if (!enableHydration || typeof document === 'undefined') return
        const onVisible = () => {
            if (document.hidden) return
            if (isHydrationFailure(useCanvasStore.getState().hydrationStatus)) retryHydration()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [enableHydration, retryHydration])

    // Re-hydrate the moment the provider-health store flips unhealthy→healthy
    // for THIS provider scope. That store learns of recovery independently of
    // this hook's retry loop (the 60s /health/providers poll, plus sub-second
    // via the X-Provider-Health header on any successful request), so a
    // completed node rotation re-hydrates the canvas immediately instead of
    // riding out the slow retry cadence. Complementary to the loop above:
    // the loop is the floor when no health signal arrives at all.
    useEffect(() => {
        if (!enableHydration || !providerWsId || !providerDsId) return
        const key = `${providerWsId}:${providerDsId}`
        let prev = useProviderHealthStore.getState().providers.get(key)?.status
        return useProviderHealthStore.subscribe((state) => {
            const curr = state.providers.get(key)?.status
            const was = prev
            prev = curr
            if (was === 'unhealthy' && curr === 'healthy') {
                if (isHydrationFailure(useCanvasStore.getState().hydrationStatus)) retryHydration()
            }
        })
    }, [enableHydration, providerWsId, providerDsId, retryHydration])

    // ─── Root loading (paged) ───────────────────────────────────────────

    // One page of top-level entities at `offset`. Shared by the initial
    // hydration (offset 0) and loadMoreRoots. Runs through the bounded
    // queue (key 'ROOT' — duplicate submissions collapse to the in-flight
    // promise) so it shares the concurrency budget with child loads.
    const submitRootPage = useCallback((offset: number) => {
        const typesToLoad = rootEntityTypes
        if (typesToLoad.length === 0) return
        return queueRef.current.submit('ROOT', async (signal) => {
            setLoadingNodes(prev => new Set(prev).add('ROOT'))
            try {
                // What is already painted. The edges leg has always covered
                // new ∪ existing, whichever path fetches it.
                const existingUrns = useCanvasStore.getState().nodes.map(n => n.id)

                let roots: GraphNode[] | null = null
                let backendEdges: GraphEdge[] | null = null

                // One request for the page, its edges and its aggregated
                // lineage — see USE_CANVAS_BOOTSTRAP. Any failure falls
                // through to the three calls below rather than surfacing:
                // the batched endpoint is an optimisation, never a new way
                // for a canvas to fail to open.
                if (USE_CANVAS_BOOTSTRAP && provider.canvasBootstrap) {
                    try {
                        const batched = await provider.canvasBootstrap({
                            rootQuery: {
                                entityTypes: typesToLoad as string[],
                                limit: ROOT_PAGE_SIZE,
                                offset,
                            },
                            visibleUrns: existingUrns,
                        })
                        if (signal.aborted) return
                        roots = batched.roots.nodes
                        backendEdges = batched.edges
                    } catch (err) {
                        console.warn(
                            '[useGraphHydration] canvas/bootstrap failed; '
                            + 'falling back to the per-purpose calls', err,
                        )
                    }
                    if (signal.aborted) return
                }

                if (roots === null) {
                    roots = await provider.getNodes({
                        entityTypes: typesToLoad as any[],
                        limit: ROOT_PAGE_SIZE,
                        offset,
                    })
                }
                if (signal.aborted) return

                // Full page ⇒ more likely exist beyond it (same heuristic
                // as the edge-truncation banners); short page ⇒ exhausted.
                rootsLoadedRef.current = offset + roots.length
                setRootsLoaded(rootsLoadedRef.current)
                setRootsHaveMore(roots.length >= ROOT_PAGE_SIZE)

                if (roots.length > 0) {
                    const nodesToAdd = roots.map(root => toCanvasNode(root))

                    if (backendEdges === null) {
                        const allUrns = [...new Set([...roots.map(r => r.urn), ...existingUrns])]
                        backendEdges = await provider.getEdgesBetween(allUrns).catch((err: unknown) => {
                            useCanvasStore.getState().noteEdgeFetchFailure(err instanceof Error ? err.message : undefined)
                            return [] as GraphEdge[]
                        })
                    }
                    if (signal.aborted) return

                    useCanvasStore.getState().addGraph(nodesToAdd, backendEdges.map(e => toCanvasEdge(e)))
                }
            } catch (err) {
                console.error('[useGraphHydration] Failed to load roots page', err)
            } finally {
                setLoadingNodes(prev => {
                    const next = new Set(prev)
                    next.delete('ROOT')
                    return next
                })
            }
        })
    }, [provider, rootEntityTypes])

    /** Load the next ROOT_PAGE_SIZE top-level entities (status chip). */
    const loadMoreRoots = useCallback(() => {
        if (loadingNodes.has('ROOT')) return
        return submitRootPage(rootsLoadedRef.current)
    }, [loadingNodes, submitRootPage])

    /**
     * The next page of each feed in `feedKeys` that has more — what a column
     * asks for as its end nears, or a Hierarchy/Graph "more" control. One
     * queued task per feed (key `TYPE:<feedKey>`, so a repeat while in flight
     * collapses onto it).
     *
     * Edges cost what the PAGE costs, never what is loaded: the page's incoming
     * containment (≤ one parent per row — what places a row under its parent),
     * lineage touching the page, and containment to already-loaded ORPHANS of a
     * type this page's type can contain (a child type paged before its
     * parent's). An edge is kept only once both ends are loaded.
     */
    const loadMoreFeeds = useCallback(async (feedKeys: string[]) => {
        const feeds = useCanvasStore.getState().typeFeeds
        const due = [...new Set(feedKeys)].filter(k => feeds[k]?.hasMore)
        await Promise.all(due.map(feedKey => {
            const key = `TYPE:${feedKey}`
            return queueRef.current.submit(key, async (signal) => {
                const feed = useCanvasStore.getState().typeFeeds[feedKey]
                if (!feed?.hasMore) return
                setFailedNodes(prev => { const next = new Set(prev); next.delete(key); return next })
                setLoadingNodes(prev => new Set(prev).add(key))
                const generation = useCanvasStore.getState().graphGeneration
                // A new graph was set while the page was in flight: it belongs to the old one.
                const stale = () => signal.aborted || useCanvasStore.getState().graphGeneration !== generation
                try {
                    // One ask makes progress or proves there is none: a page whose
                    // rows are all held already would otherwise look like a click
                    // that did nothing. Bounded, as a feed can be long.
                    let readAt = feed.offset
                    for (let walk = 0; walk < FEED_WALK_MAX_PAGES; walk++) {
                        const result = await provider.getNodesPage({
                            entityTypes: feed.entityTypes,
                            limit: PER_TYPE_LIMIT,
                            offset: readAt,
                        })
                        if (stale()) return
                        const page = result.nodes
                        const pageUrns = page.map(n => n.urn)
                        const before = useCanvasStore.getState()
                        const childTypes = new Set(feed.entityTypes.flatMap(t =>
                            schemaEntityTypes.find(e => e.id === t)?.hierarchy?.canContain ?? []))
                        let orphans: string[] = []
                        if (childTypes.size > 0 && containmentEdgeTypes.length > 0) {
                            const parented = new Set<string>()
                            for (const e of before.edges) {
                                if (isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) parented.add(e.target)
                            }
                            orphans = before.nodes
                                .filter(n => childTypes.has(n.data.type) && !parented.has(n.id))
                                .map(n => n.id)
                        }
                        const noteFailure = (err: unknown): GraphEdge[] => {
                            useCanvasStore.getState().noteEdgeFetchFailure(err instanceof Error ? err.message : undefined)
                            return []
                        }
                        // Lineage out of and into the page as two ANCHORED reads: the
                        // one-query `anyUrns` form has no index-friendly shape and scans
                        // every lineage edge of the graph for each page.
                        const none = Promise.resolve([] as GraphEdge[])
                        const [incoming, lineageOut, lineageIn, adopted] = pageUrns.length === 0 ? [[], [], [], []] : await Promise.all([
                            containmentEdgeTypes.length > 0
                                ? provider.getEdges({ targetUrns: pageUrns, edgeTypes: containmentEdgeTypes, limit: pageUrns.length * 4 + 100 }).catch(noteFailure)
                                : none,
                            lineageEdgeTypes.length > 0
                                ? provider.getEdges({ sourceUrns: pageUrns, edgeTypes: lineageEdgeTypes, limit: 200_000 }).catch(noteFailure)
                                : none,
                            lineageEdgeTypes.length > 0
                                ? provider.getEdges({ targetUrns: pageUrns, edgeTypes: lineageEdgeTypes, limit: 200_000 }).catch(noteFailure)
                                : none,
                            orphans.length > 0
                                ? provider.getEdgesBetween([...pageUrns, ...orphans], containmentEdgeTypes).catch(noteFailure)
                                : none,
                        ])
                        if (stale()) return

                        const held = useCanvasStore.getState()._nodeIndex
                        const onPage = new Set(pageUrns)
                        const isLoaded = (u: string) => held.has(u) || onPage.has(u)
                        const edges = [...incoming, ...lineageOut, ...lineageIn, ...adopted]
                            .filter(e => isLoaded(e.sourceUrn) && isLoaded(e.targetUrn))
                        const fresh = page.filter((n, i) => !held.has(n.urn) && pageUrns.indexOf(n.urn) === i)
                        // ONE store update: nodes, edges and the feed's position —
                        // unless another instance of this hook moved the feed on
                        // meanwhile: then the rows land and its position stands.
                        const next = feedAfter(feed.entityTypes, result, readAt)
                        const store = useCanvasStore.getState()
                        if ((store.typeFeeds[feedKey]?.offset ?? readAt) !== readAt) {
                            store.addGraph(fresh.map(n => toCanvasNode(n)), edges.map(e => toCanvasEdge(e)))
                            break
                        }
                        store.addFeedPage(feedKey, next, fresh.map(n => toCanvasNode(n)), edges.map(e => toCanvasEdge(e)))
                        if (fresh.length > 0 || !next.hasMore) break
                        readAt = next.offset
                    }
                } catch (err) {
                    console.error(`[useGraphHydration] Failed to load more of feed ${feedKey}`, err)
                    setFailedNodes(prev => new Set(prev).add(key))
                } finally {
                    setLoadingNodes(prev => { const next = new Set(prev); next.delete(key); return next })
                }
            })
        }))
    }, [provider, containmentEdgeTypes, lineageEdgeTypes, schemaEntityTypes])

    // ─── loadChildren ───────────────────────────────────────────────────

    const loadChildren = useCallback(async (parentId: string, options?: LoadChildrenOptions) => {
        /** Land a page (nodes, edges, position) as ONE store update. Another
         *  instance of this hook may have paged this parent further meanwhile —
         *  then the rows land but the position stays where that one left it. */
        const commit = (pos: ChildPageState, nodesToAdd: LineageNode[], edgesToAdd: LineageEdge[]) => {
            const store = useCanvasStore.getState()
            const cur = store.childPaging[parentId]
            const further = !!cur && cur.direction === pos.direction && cur.childCount === pos.childCount
                && cur.offset > pos.offset
            if (further) store.addGraph(nodesToAdd, edgesToAdd)
            else store.addChildPage(parentId, pos, nodesToAdd, edgesToAdd)
        }
        // ── Handle root loading (empty parentId) ────────────────────
        if (!parentId) {
            if (loadingNodes.has('ROOT')) return
            if (!isSchemaReady) return
            if (rootEntityTypes.length === 0) return

            const key = `all:${rootEntityTypes.join(',')}`
            if (rootsAttemptedForRef.current === key) return
            rootsAttemptedForRef.current = key
            rootsLoadedRef.current = 0
            setRootsLoaded(0)
            setRootsHaveMore(false)

            await submitRootPage(0)
            return
        }

        // ── Handle child loading (specific parentId) ────────────────
        // Note: BoundedQueue collapses duplicate keys to the in-flight
        // promise, so a redundant click while loading is a no-op without
        // the explicit guard below. The guard remains as a fast-path.
        if (loadingNodes.has(parentId)) return
        const direction = options?.sortDirection ?? 'asc'

        // Where this parent's pager resumes — read from the store AT THE MOMENT
        // it is asked (null = nothing to fetch). A live pager — same order, same
        // childCount, its last child still in the store — resumes where the SERVER
        // said the next page starts, and it alone says when the parent is
        // exhausted. Anything else (first expand, a graph replaced under it, the
        // other sort order) starts at the TOP: the children already held are not
        // necessarily the first ones in this order — a prefetch in the other
        // direction, children placed by hand — so starting after "however many are
        // held" skipped the rest for good. Rows already held are skipped as they
        // come back.
        const resumeFor = (): { parentNode: LineageNode; childCount: number; at: ChildPageState } | null => {
            const { nodes, edges, _nodeIndex, childPaging } = useCanvasStore.getState()
            const parentNode = nodes.find(n => n.id === parentId)
            if (!parentNode) return null
            const nodeData = parentNode.data as { childCount?: number | null; metadata?: { childCount?: number | null } }
            // UNKNOWN IS NOT ZERO.
            //
            // `childCount` is deliberately null on any read path that cannot count
            // containment edges live — `/ancestors` is one, and it is exactly the
            // path a deep reveal seeds its chain from. Folding that null into 0
            // meant every such ancestor was treated as childless and its page was
            // never fetched: the reveal stopped partway, the target never landed,
            // and the container rendered with no children and no way to open it.
            //
            // Only a counted zero means "nothing to load". Unknown means "ask".
            const rawChildCount = nodeData.childCount ?? nodeData.metadata?.childCount
            if (rawChildCount === 0) return null
            const childCount = typeof rawChildCount === 'number' ? rawChildCount : Number.POSITIVE_INFINITY
            const live = childPaging[parentId]
            const resumable = !!live && live.direction === direction && live.childCount === childCount
                && (live.lastUrn === null || _nodeIndex.has(live.lastUrn))
            if (resumable) return live.hasMore ? { parentNode, childCount, at: live } : null
            const existingNodeIds = new Set(nodes.map(n => n.id))
            // Optimistic, unsaved children aren't part of the backend's `childCount` and have no
            // server page — counting them would trip the "all loaded" short-circuit.
            // Tally only SAVED children here.
            const pendingNodeIds = new Set(
                nodes.filter(n => n.data?.isPending === 'create').map(n => n.id),
            )
            // A child primed out of band by a search reveal (`useRevealSearchHit`)
            // is not "loaded" by any page — same rule as optimistic children.
            const revealedNodeIds = new Set(
                nodes.filter(n => n.data?.viaReveal).map(n => n.id),
            )
            // Count loaded SAVED children via containment edges (ontology-driven)
            const currentChildrenCount = edges.filter(e => {
                if (e.source !== parentId) return false
                if (!existingNodeIds.has(e.target)) return false
                if (e.data?.isPending === 'create' || pendingNodeIds.has(e.target)) return false
                if (revealedNodeIds.has(e.target)) return false
                return isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)
            }).length
            // If we have all children, don't refetch
            if (currentChildrenCount >= childCount && childCount > 0) return null
            return { parentNode, childCount, at: { offset: 0, hasMore: true, direction, lastUrn: null, childCount } }
        }
        // Fast exit before queueing; the task asks again when it actually runs.
        if (!resumeFor()) return

        let summary: ChildLoadSummary | undefined
        await queueRef.current.submit(parentId, async (signal) => {
            // Read the graph generation BEFORE the position: a load that waited in
            // the queue while the graph was replaced must page the NEW graph from
            // the new graph's position — never carry the old one in.
            const generation = useCanvasStore.getState().graphGeneration
            const start = resumeFor()
            if (!start) return
            const { parentNode, childCount } = start
            setFailedNodes(prev => { const next = new Set(prev); next.delete(parentId); return next })
            setLoadingNodes(prev => new Set(prev).add(parentId))
            const stale = () => signal.aborted || useCanvasStore.getState().graphGeneration !== generation
            let pos = start.at
            // A position reached by pages that brought nothing new is committed ONCE,
            // not per page: every store update re-renders the whole canvas.
            let uncommitted = false
            try {
                const urn = (parentNode.data.urn as string) || parentId
                const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined
                let added = 0

                // One call makes progress or proves there is none. A page whose
                // rows are already held (search reveals, a restart from the top)
                // brings nothing new; stopping there would leave the "load more"
                // row where it was — a silent stall. Bounded by the pages this
                // parent can have; with its count unknown there is no such bound,
                // so it walks as far as a feed does (a server that ignores the
                // offset would otherwise be asked for the same page forever). The
                // ground covered is kept, so the next ask carries on from there.
                const maxPages = Number.isFinite(childCount)
                    ? Math.ceil(childCount / CHILDREN_PAGE_SIZE) + 2
                    : FEED_WALK_MAX_PAGES
                for (let page = 0; page < maxPages; page++) {
                    const offset = pos.offset
                    // Single round-trip: children + containment edges + lineage edges
                    const result = await provider.getChildrenWithEdges(urn, {
                        edgeTypes: fetchTypes,
                        lineageEdgeTypes: lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined,
                        limit: CHILDREN_PAGE_SIZE,
                        // By POSITION, the next one taken from the server: works on
                        // every provider and every naming scheme (no name-based
                        // cursor that a missing displayName or a draft breaks).
                        offset,
                        includeLineageEdges: true,
                        // Cross-page sibling lineage arrives WITH each page — cost
                        // proportional to the page, where the old supplement
                        // re-sent every loaded sibling (quadratic per parent).
                        lineageScope: 'siblings',
                        sortDirection: options?.sortDirection,
                    })

                    // User collapsed mid-load, or a new graph was set while this
                    // page was in flight: the page belongs to the OLD graph. Landing
                    // it would adopt a position the new graph never earned.
                    if (stale()) return

                    const { _nodeIndex: held, _edgeIndex: heldEdges } = useCanvasStore.getState()
                    const nodesToAdd: LineageNode[] = []
                    const newIds = new Set<string>()
                    const reDelivered: string[] = []
                    for (const child of result.children) {
                        if (held.has(child.urn)) reDelivered.push(child.urn)
                        else if (!newIds.has(child.urn)) {
                            nodesToAdd.push(toCanvasNode(child))
                            newIds.add(child.urn)
                        }
                    }

                    // A sibling edge whose far end is not loaded yet is held back —
                    // it comes again with that sibling's own page — so nothing is
                    // lost.
                    const isLoaded = (u: string) => u === parentId || u === urn || held.has(u) || newIds.has(u)
                    const edgesToAdd = [
                        ...result.containmentEdges,
                        ...result.lineageEdges.filter(e => isLoaded(e.sourceUrn) && isLoaded(e.targetUrn)),
                    ].map(e => toCanvasEdge(e))

                    pos = pagerAfter(result, offset, direction, childCount, pos.lastUrn)
                    const progressed = nodesToAdd.length > 0 || edgesToAdd.some(e => !heldEdges.has(e.id))
                    if (progressed || !pos.hasMore) {
                        commit(pos, nodesToAdd, edgesToAdd)
                        uncommitted = false
                    } else {
                        uncommitted = true
                    }
                    added += nodesToAdd.length

                    // The page's lineage to the REST of the canvas. The server
                    // answers this request with cross-child lineage only —
                    // edges between the children it returned, deliberately, to
                    // keep that query O(pageSize²) — so a row from "Load 13
                    // more" arrived with no flow to anything already on screen.
                    // Fired after the commit so the rows paint immediately and
                    // their wires follow; a failure costs those rows their
                    // flows, not the page.
                    if (nodesToAdd.length > 0) {
                        void primeLineageFor(
                            provider,
                            nodesToAdd.map((n) => n.id),
                            lineageEdgeTypes,
                        ).then((extra) => {
                            // stale(), not only the signal: flows read for a graph
                            // that has since been replaced do not belong in the new one.
                            if (extra.length > 0 && !stale()) {
                                useCanvasStore.getState().addGraph([], extra)
                            }
                        }).catch((e) => {
                            console.warn('[children] lineage priming failed', e)
                        })
                    }

                    // A revealed child this page actually delivered is now a
                    // normal loaded child — clear the flag.
                    if (reDelivered.length > 0) {
                        const wanted = new Set(reDelivered)
                        const { nodes: now, updateNode } = useCanvasStore.getState()
                        for (const n of now) {
                            if (wanted.has(n.id) && n.data?.viaReveal) updateNode(n.id, { viaReveal: false })
                        }
                    }

                    // The facts about this page, for whoever asked for it. Set
                    // only on a page that actually completed — an aborted or
                    // failed load has nothing true to say.
                    summary = {
                        // `|| urn`, not `?? ''`: a container whose backend
                        // displayName is "" would otherwise be announced as
                        // " · 5 datasets" — a message with no subject.
                        parentLabel: String(parentNode.data.label || urn),
                        parentType: parentNode.data.type as string | undefined,
                        arrived: result.children.length,
                        offset,
                        total: childCount,
                        childTypes: [...new Set(result.children.map(c => c.entityType).filter(Boolean))],
                    }
                    if (nodesToAdd.length > 0 || !pos.hasMore) break
                }

                if (added > 0) console.log(`[useGraphHydration] Loaded ${added} children for ${parentId}`)
            } catch (err) {
                console.error(`[useGraphHydration] Failed to load children for ${parentId}`, err)
                setFailedNodes(prev => new Set(prev).add(parentId))
            } finally {
                // Keep the ground covered, so the next ask resumes past it.
                if (uncommitted && !stale()) commit(pos, [], [])
                setLoadingNodes(prev => {
                    const next = new Set(prev)
                    next.delete(parentId)
                    return next
                })
            }
        })
        // Undefined when the queue collapsed this call onto an in-flight one
        // with the same key (the task never ran), and when the load aborted
        // or failed — in every one of those cases there is nothing to report.
        return summary
    }, [provider, containmentEdgeTypes, lineageEdgeTypes, rootEntityTypes, schemaEntityTypes, isSchemaReady, loadingNodes, submitRootPage])

    /**
     * Cancel a queued or in-flight load for `parentId`. Aborts the
     * task's signal so the result is not committed; the network request
     * itself may still complete (provider methods don't accept a signal
     * yet) but its data is discarded. Safe to call when the parent is
     * not loading — no-op in that case.
     */
    // Parents the server said are exhausted, with the childCount that verdict was
    // given against — a consumer honours it only while the parent's childCount is
    // still that, so children that appear later are never hidden. From the store,
    // so every instance of this hook agrees.
    const childPaging = useCanvasStore(s => s.childPaging)
    const exhaustedParents = useMemo(
        () => new Map(Object.entries(childPaging).filter(([, p]) => !p.hasMore).map(([id, p]) => [id, p.childCount])),
        [childPaging],
    )

    const cancelChildLoad = useCallback((parentId: string) => {
        queueRef.current.cancel(parentId)
    }, [])

    return {
        loadChildren,
        cancelChildLoad,
        isLoading: loadingNodes.size > 0,
        loadingNodes,
        failedNodes,
        hydrationPhase,
        hydrationError,
        hydrationStatus,
        /** Explicit user retry (overlay "Retry" button). Re-arms a fresh round
         *  of bounded auto-retries. */
        retryHydration,
        loadMoreRoots,
        rootsLoaded,
        rootsHaveMore,
        exhaustedParents,
        loadMoreFeeds,
    }
}
