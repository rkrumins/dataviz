import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
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
import type { GraphNode, GraphEdge, EntityTypeDefinition } from '@/providers/GraphDataProvider'
import { BoundedQueue } from '@/lib/concurrency'
import { toCanvasNode, toCanvasEdge } from '@/lib/canvasNodeMapper'
import { useBranchCreatedDelta, committedCreatedUrns } from '@/hooks/useBranchCreatedDelta'
import { useIsDraftMode, useBranchStore } from '@/store/branchStore'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max entities per type per fetch. Keeps initial loads manageable. */
const PER_TYPE_LIMIT = 200

/**
 * Cap on parallel `loadChildren` calls in flight. A user clicking "expand
 * all" on a 200-node hierarchy must not fan out 200 simultaneous network
 * requests — that is the primary cause of 300–400% FalkorDB CPU spikes
 * documented in docs/audits/. 6 matches a browser's HTTP/1.1 connection
 * cap; tune via VITE_CHILD_LOAD_CONCURRENCY if needed.
 */
const CHILD_LOAD_CONCURRENCY = (() => {
    const fromEnv = Number(import.meta.env?.VITE_CHILD_LOAD_CONCURRENCY)
    return Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 6
})()

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface LoadChildrenOptions {
    // Reserved for future use. The useAllSchemaTypes option was removed —
    // the Entity Browser now uses the dedicated useEntityBrowser hook.
}

export type HydrationPhase = 'idle' | 'roots' | 'edges' | 'children' | 'complete'

/**
 * Authoritative hydration state machine. ALL terminal canvas UI (empty state,
 * provider overlay, success toasts) derives from this single value so the
 * "genuinely empty" and "failed/loading" cases can never be confused — not
 * even transiently during an auto-retry. Transitions:
 *   loading → ready        (a fetch SUCCEEDED — canvas renders; empty-state
 *                           only if it returned 0 nodes)
 *   loading → warming      (provider is loading its dataset — friendly overlay)
 *   loading → unavailable  (provider down / hard error — overlay)
 *   warming/unavailable → ready  (a retry succeeded)
 * A retry NEVER leaves warming/unavailable until it actually succeeds, so the
 * overlay stays put and "Start building" can't flash between attempts.
 */
export type HydrationStatus = 'loading' | 'ready' | 'warming' | 'unavailable'

/** Thrown by the reference-view load when the view SHOULD have entities
 *  (has assignments / branch-created delta) but every fetch failed — so the
 *  canvas surfaces the failure instead of a false "empty / Start building".
 *  `warming` = the provider is starting up (retryable), vs a hard outage. */
class HydrationLoadError extends Error {
    constructor(public warming: boolean) {
        super(warming ? 'PROVIDER_LOADING' : 'provider-unavailable')
        this.name = 'HydrationLoadError'
    }
}

export interface UseGraphHydrationResult {
    /** Load children for a node (empty string = load roots). */
    loadChildren: (parentId: string, options?: LoadChildrenOptions) => Promise<void>
    /** Search children under a parent node. */
    searchChildren: (parentId: string, query: string) => Promise<void>
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
    /** Current phase of initial hydration (only meaningful when hydrate=true). */
    hydrationPhase: HydrationPhase
    /** Error message if hydration failed (e.g. provider unavailable/warming). */
    hydrationError: string | null
    /** Authoritative terminal state. Drives the canvas overlay/empty-state so a
     *  failed/warming/loading load is never rendered as an empty graph. */
    hydrationStatus: HydrationStatus
}

interface UseGraphHydrationOptions {
    /**
     * When true, runs the initial hydration effect that loads root nodes + edges
     * on mount / view change. Only ONE component should set this to true
     * (CanvasRouter). All other consumers should leave it false (default) and
     * only use loadChildren / searchChildren.
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
    const { providerVersion } = useGraphProviderContext()
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

    // Track (provider, viewId) so reference views reload when the active view changes.
    const initializedKeyRef = useRef<string | null>(null)

    // Bounded queue for child-load tasks. Caps parallel `loadChildren`
    // calls at CHILD_LOAD_CONCURRENCY and exposes per-key cancellation
    // (used by the canvas when a user collapses a node mid-load).
    const queueRef = useRef<BoundedQueue>(new BoundedQueue(CHILD_LOAD_CONCURRENCY))

    // Reset when provider changes (e.g. workspace/datasource switch)
    useEffect(() => {
        rootsAttemptedForRef.current = null
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
    // loadChildren / searchChildren.

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

        // A genuinely NEW view (new initKey) resets the retry budget and shows
        // the fresh 'loading' state. A RETRY of the same view (same initKey,
        // re-armed via retryEpoch) keeps the failed status/overlay up so it
        // can't flash the empty state between attempts.
        const isFreshView = lastInitKeyRef.current !== initKey
        if (isFreshView) {
            lastInitKeyRef.current = initKey
            retryCountRef.current = 0
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

        // Clear the canvas nodes for the fresh attempt. Do NOT clear
        // hydrationError/status on a RETRY — that's what caused the overlay to
        // blink to "Start building" between attempts; a retry only clears them
        // by SUCCEEDING (markReady) below.
        setGraph([], [])

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
                    const { assignments } = normalizeReferenceLayout(activeView?.layout?.referenceLayout)
                    const assignedUrns = new Set<string>()
                    for (const [urn, entry] of Object.entries(assignments)) {
                        if (entry?.layerId) assignedUrns.add(urn)
                    }

                    const hasExplicitAssignments = assignedUrns.size > 0

                    setHydrationPhase('roots')

                    let allNodes: GraphNode[] = []
                    // Count of branch-created URNs unioned into the assigned set below
                    // (0 outside a draft / with an empty delta) — logging only.
                    let deltaLoadedCount = 0

                    // Track whether any node fetch FAILED (vs legitimately returned
                    // []). A per-batch .catch(()=>[]) tolerates a partial failure,
                    // but must not silently turn a TOTAL failure into "empty graph"
                    // — that's what rendered a warming provider as "Start building".
                    let anyBatchErrored = false
                    let anyWarming = false
                    const safeGetNodes = async (q: Parameters<typeof provider.getNodes>[0]): Promise<GraphNode[]> => {
                        try {
                            return await provider.getNodes(q)
                        } catch (e) {
                            anyBatchErrored = true
                            if (String((e as Error)?.message ?? e).includes('PROVIDER_LOADING')) anyWarming = true
                            return [] as GraphNode[]
                        }
                    }

                    if (hasExplicitAssignments) {
                        // ── Assignment-driven loading ──
                        // Load the specific entities assigned to layers by URN,
                        // UNIONED (in a draft) with entities created in this
                        // branch — they have no persisted entityAssignment yet
                        // and would otherwise never be fetched. Empty delta /
                        // non-draft ⇒ assigned-only, identical to before.
                        const urnBatches: string[][] = []
                        const urnArray = closedScopeLoadUrns(assignedUrns, branchCreatedDelta, isDraft)
                        deltaLoadedCount = urnArray.length - assignedUrns.size
                        // Batch URNs to avoid overly large queries
                        for (let i = 0; i < urnArray.length; i += 100) {
                            urnBatches.push(urnArray.slice(i, i + 100))
                        }

                        const batchResults = await Promise.all(
                            urnBatches.map(batch =>
                                safeGetNodes({ urns: batch as any[], limit: batch.length })
                            )
                        )
                        allNodes = batchResults.flat()
                        if (controller.signal.aborted) return

                        // Children are NOT prefetched. Top-level assigned entities
                        // render collapsed; the user expands a parent to fire the
                        // existing 20-per-page lazy loader (loadChildren below),
                        // and AutoLoadSentinel pages through the rest on scroll.
                    } else {
                        // ── Type-based loading (empty/new views) ──
                        // No assignments yet — load by entity type so the view has data
                        // for the user to start assigning in the wizard.
                        // An EMPTY result is a terminal state, not a stall: mark hydration
                        // complete so the canvas leaves its ghost-loading UI and renders
                        // its real empty states (blank models legitimately start at zero).
                        const rootTypes = computeViewScopedRoots(viewTypes, schemaEntityTypes, rootEntityTypes)
                        if (rootTypes.length === 0) {
                            markReady()
                            return
                        }

                        const rootResults = await Promise.all(
                            rootTypes.map(et =>
                                safeGetNodes({ entityTypes: [et], limit: PER_TYPE_LIMIT })
                            )
                        )
                        allNodes = rootResults.flat()
                        if (controller.signal.aborted) return
                        if (allNodes.length === 0) {
                            // Any fetch error → warming/outage, not "empty" (see the
                            // shared empty-check above for the rationale).
                            if (anyBatchErrored) {
                                throw new HydrationLoadError(anyWarming)
                            }
                            markReady()
                            return
                        }

                        // Also load remaining visible types (non-root layers)
                        setHydrationPhase('children')
                        const loadedRootTypes = new Set(allNodes.map(n => n.entityType))
                        const remainingTypes = viewTypes.filter(t => !loadedRootTypes.has(t))
                        if (remainingTypes.length > 0) {
                            const childResults = await Promise.all(
                                remainingTypes.map(et =>
                                    safeGetNodes({ entityTypes: [et], limit: PER_TYPE_LIMIT })
                                )
                            )
                            const childNodes = childResults.flat()
                            if (controller.signal.aborted) return
                            allNodes = [...allNodes, ...childNodes]
                        }
                    }

                    if (allNodes.length === 0) {
                        // Distinguish "failed to load" from "genuinely empty" by the
                        // ONLY reliable signal: did a fetch error? A healthy provider
                        // returns [] with no error for a truly empty view; a
                        // down/warming provider throws. If ANY fetch errored we must
                        // surface warming/outage (overlay + auto-retry) — never a false
                        // "No entities yet / Start building" over data that may exist.
                        // (Assignments/draft-state are NOT part of this decision — a
                        // Published view with no assignments still must not lie "empty"
                        // when the provider is down.)
                        if (anyBatchErrored) {
                            throw new HydrationLoadError(anyWarming)
                        }
                        markReady()   // empty view — terminal, not a stall
                        return
                    }

                    // Show nodes immediately, then fetch edges
                    setGraph(
                        allNodes.map(n => toCanvasNode(n)),
                        [],
                    )

                    // Fetch edges between all loaded nodes. Pass the backend
                    // hard maximum so the user's assigned set is never
                    // truncated at the 50k default on large graphs.
                    setHydrationPhase('edges')
                    const allUrns = allNodes.map(n => n.urn)
                    const allEdges = await provider.getEdgesBetween(allUrns, undefined, 200_000).catch(() => [] as GraphEdge[])
                    if (controller.signal.aborted) return

                    // Replace with complete dataset atomically
                    setGraph(
                        allNodes.map(n => toCanvasNode(n)),
                        allEdges.map(e => toCanvasEdge(e)),
                    )

                    console.log(`[useGraphHydration] Reference view: loaded ${allNodes.length} nodes (${assignedUrns.size} assigned, ${deltaLoadedCount} branch-created), ${allEdges.length} edges`)
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

                    // Step 1: Fetch root nodes
                    setHydrationPhase('roots')
                    const rootNodes = await provider.getNodes({
                        entityTypes: typesToLoad as any[],
                        limit: PER_TYPE_LIMIT,
                    })
                    if (controller.signal.aborted) return
                    if (rootNodes.length === 0) {
                        markReady()   // empty graph — terminal, not a stall
                        return
                    }

                    // Show roots immediately
                    setGraph(
                        rootNodes.map(n => toCanvasNode(n, { randomPosition: true })),
                        [],
                    )

                    // Step 2: Fetch first-level children for all roots (parallel)
                    setHydrationPhase('children')
                    const childrenPromises = rootNodes.map(root =>
                        provider.getChildren(root.urn, { limit: 100 })
                            .catch(() => [] as GraphNode[])
                    )
                    const childrenResults = await Promise.all(childrenPromises)
                    const allChildren = childrenResults.flat()
                    if (controller.signal.aborted) return

                    // Step 3: Fetch orphaned nodes of child types (nodes without
                    // a parent in our root set, e.g. dataPlatforms without a domain)
                    const entityTypeHierarchy = schemaEntityTypes
                    const childTypes = new Set<string>()
                    for (const rootType of typesToLoad) {
                        const et = entityTypeHierarchy.find(e => e.id === rootType)
                        et?.hierarchy?.canContain?.forEach((t: string) => childTypes.add(t))
                    }

                    let orphanNodes: GraphNode[] = []
                    if (childTypes.size > 0) {
                        const childTypeNodes = await provider.getNodes({
                            entityTypes: [...childTypes] as any[],
                            limit: PER_TYPE_LIMIT,
                        }).catch(() => [] as GraphNode[])
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
                    if (uniqueNodes.length === 0) {
                        markReady()   // empty graph — terminal
                        return
                    }

                    // Step 4: Fetch edges between ALL loaded nodes
                    setHydrationPhase('edges')
                    const allUrns = uniqueNodes.map(n => n.urn)
                    const allEdges = await provider.getEdgesBetween(allUrns).catch(() => [] as GraphEdge[])
                    if (controller.signal.aborted) return

                    console.log(`[useGraphHydration] Loaded ${uniqueNodes.length} nodes (${rootNodes.length} roots, ${allChildren.length} children, ${orphanNodes.length} orphans), ${allEdges.length} edges`)

                    setGraph(
                        uniqueNodes.map(n => toCanvasNode(n, { randomPosition: true })),
                        allEdges.map(e => toCanvasEdge(e)),
                    )
                }

                markReady()
            } catch (err) {
                if (!controller.signal.aborted) {
                    const msg = err instanceof Error ? err.message : 'Failed to load graph data'
                    // "Warming" = the provider is loading its dataset (restart) —
                    // transient and auto-retried, shown with a friendly tone. Anything
                    // else that looks like a connectivity failure is a hard outage.
                    const warming = (err instanceof HydrationLoadError && err.warming)
                        || msg.includes('PROVIDER_LOADING')
                    if (warming) {
                        console.warn('[useGraphHydration] Provider warming up — retrying:', msg)
                    } else {
                        console.error('[useGraphHydration] Hydration failed:', err)
                    }
                    // Single failure terminal: set the authoritative status. The
                    // overlay + auto-retry derive from this; it stays until a retry
                    // SUCCEEDS (markReady), so "Start building" can't flash between
                    // attempts. Phase → complete so the loading ghosts stop.
                    setHydrationStatus(warming ? 'warming' : 'unavailable')
                    setHydrationError(
                        warming
                            ? 'Your graph is starting up…'
                            : 'The graph provider for this view is unavailable. Your data is safe — this view will load automatically once the provider is back.'
                    )
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

    // Auto-retry while the provider is warming/unavailable, so the canvas
    // recovers on its own once the graph is back — no manual refresh. Both
    // warming and hard-down auto-recover the moment the provider answers, so
    // both retry persistently (~30 attempts, ≈4 min of 8s-capped backoff) then
    // stop. CRITICALLY, a retry does NOT clear hydrationStatus/error — it only
    // re-arms the load (retryEpoch); the status flips to 'ready' only by a
    // SUCCESSFUL load (markReady). So the overlay stays put and can never blink
    // to "Start building" between attempts. retryEpoch is a dep so this effect
    // re-evaluates after each attempt and schedules the next while still failed.
    useEffect(() => {
        if (!enableHydration) return
        if (hydrationStatus !== 'warming' && hydrationStatus !== 'unavailable') {
            retryCountRef.current = 0
            return
        }
        const maxRetries = 30
        if (retryCountRef.current >= maxRetries) return
        const attempt = retryCountRef.current + 1
        const delay = Math.min(2000 * 2 ** (attempt - 1), 8000) // 2s, 4s, 8s, 8s…
        const t = setTimeout(() => {
            retryCountRef.current = attempt
            initializedKeyRef.current = null   // re-arm the hydration effect
            setRetryEpoch(e => e + 1)          // re-run; status/overlay stay until success
        }, delay)
        return () => clearTimeout(t)
    }, [enableHydration, hydrationStatus, retryEpoch])

    // ─── loadChildren ───────────────────────────────────────────────────

    const loadChildren = useCallback(async (parentId: string, _options?: LoadChildrenOptions) => {
        const { nodes, edges, addGraph } = useCanvasStore.getState()

        // ── Handle root loading (empty parentId) ────────────────────
        if (!parentId) {
            if (loadingNodes.has('ROOT')) return
            if (!isSchemaReady) return

            const typesToLoad = rootEntityTypes

            if (typesToLoad.length === 0) return

            const key = `all:${typesToLoad.join(',')}`
            if (rootsAttemptedForRef.current === key) return
            rootsAttemptedForRef.current = key

            // Roots load through the bounded queue too so it shares the
            // concurrency budget with child loads under "expand all".
            return queueRef.current.submit('ROOT', async (signal) => {
                setLoadingNodes(prev => new Set(prev).add('ROOT'))
                try {
                    const roots = await provider.getNodes({
                        entityTypes: typesToLoad as any[],
                        limit: 200,
                    })
                    if (signal.aborted) return

                    if (roots.length > 0) {
                        const nodesToAdd = roots.map(root => toCanvasNode(root))

                        // Fetch real edges from backend
                        const existingUrns = useCanvasStore.getState().nodes.map(n => n.id)
                        const allUrns = [...new Set([...roots.map(r => r.urn), ...existingUrns])]
                        const backendEdges = await provider.getEdgesBetween(allUrns).catch(() => [] as GraphEdge[])
                        if (signal.aborted) return

                        addGraph(nodesToAdd, backendEdges.map(e => toCanvasEdge(e)))
                    }
                } catch (err) {
                    console.error('[useGraphHydration] Failed to load roots', err)
                } finally {
                    setLoadingNodes(prev => {
                        const next = new Set(prev)
                        next.delete('ROOT')
                        return next
                    })
                }
            })
        }

        // ── Handle child loading (specific parentId) ────────────────
        const parentNode = nodes.find(n => n.id === parentId)
        if (!parentNode) return
        // Note: BoundedQueue collapses duplicate keys to the in-flight
        // promise, so a redundant click while loading is a no-op without
        // the explicit guard below. The guard remains as a fast-path.
        if (loadingNodes.has(parentId)) return

        const nodeData = parentNode.data as any
        const childCount = (nodeData.childCount as number) ?? (nodeData.metadata?.childCount as number) ?? 0
        if (childCount === 0) return

        const existingNodeIds = new Set(nodes.map(n => n.id))
        // Optimistic, unsaved children aren't part of the backend's `childCount` and have no
        // server page — counting them would skew the pagination offset (skipping a real child)
        // and trip the "all loaded" short-circuit. Tally only SAVED children here.
        const pendingNodeIds = new Set(
            nodes.filter(n => (n.data as any)?.isPending === 'create').map(n => n.id),
        )

        // Count loaded SAVED children via containment edges (ontology-driven)
        const currentChildrenCount = edges.filter(e => {
            if (e.source !== parentId) return false
            if (!existingNodeIds.has(e.target)) return false
            if (e.data?.isPending === 'create' || pendingNodeIds.has(e.target)) return false
            return isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)
        }).length

        // If we have all children, don't refetch
        if (currentChildrenCount >= childCount && childCount > 0) return

        return queueRef.current.submit(parentId, async (signal) => {
            setFailedNodes(prev => { const next = new Set(prev); next.delete(parentId); return next })
            setLoadingNodes(prev => new Set(prev).add(parentId))
            try {
                const urn = (parentNode.data.urn as string) || parentId
                const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined

                // Single round-trip: children + containment edges + lineage edges
                const result = await provider.getChildrenWithEdges(urn, {
                    edgeTypes: fetchTypes,
                    lineageEdgeTypes: lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined,
                    limit: 20,
                    offset: currentChildrenCount,
                    includeLineageEdges: true,
                })

                // User collapsed mid-load — drop the result silently
                if (signal.aborted) return

                if (result.children.length > 0) {
                    const currentExistingNodeIds = new Set(
                        useCanvasStore.getState().nodes.map(n => n.id)
                    )

                    const nodesToAdd: LineageNode[] = []
                    const newIds = new Set<string>()

                    result.children.forEach(child => {
                        if (!currentExistingNodeIds.has(child.urn) && !newIds.has(child.urn)) {
                            nodesToAdd.push(toCanvasNode(child))
                            newIds.add(child.urn)
                        }
                    })

                    const edgesToAdd = [
                        ...result.containmentEdges,
                        ...result.lineageEdges,
                    ].map(e => toCanvasEdge(e))

                    // Single atomic commit — nodes and edges arrive together
                    const { addGraph: addGraphFresh } = useCanvasStore.getState()
                    addGraphFresh(nodesToAdd, edgesToAdd)

                    console.log(`[useGraphHydration] Loaded ${nodesToAdd.length} children for ${parentId}`)
                }
            } catch (err) {
                console.error(`[useGraphHydration] Failed to load children for ${parentId}`, err)
                setFailedNodes(prev => new Set(prev).add(parentId))
            } finally {
                setLoadingNodes(prev => {
                    const next = new Set(prev)
                    next.delete(parentId)
                    return next
                })
            }
        })
    }, [provider, containmentEdgeTypes, lineageEdgeTypes, rootEntityTypes, schemaEntityTypes, isSchemaReady, loadingNodes])

    /**
     * Cancel a queued or in-flight load for `parentId`. Aborts the
     * task's signal so the result is not committed; the network request
     * itself may still complete (provider methods don't accept a signal
     * yet) but its data is discarded. Safe to call when the parent is
     * not loading — no-op in that case.
     */
    const cancelChildLoad = useCallback((parentId: string) => {
        queueRef.current.cancel(parentId)
    }, [])

    // ─── searchChildren ─────────────────────────────────────────────────

    const searchChildren = useCallback(async (parentId: string, query: string) => {
        if (!query.trim()) return

        // Submit under a distinct keyspace so a concurrent loadChildren
        // for the same parent doesn't collapse into the search task.
        return queueRef.current.submit(`search:${parentId}`, async (signal) => {
            setLoadingNodes(prev => new Set(prev).add(parentId))
            try {
                const { nodes, removeNodes, removeEdges, addGraph } = useCanvasStore.getState()

                const parentNode = nodes.find(n => n.id === parentId)
                const urn = parentNode ? (parentNode.data.urn as string || parentId) : parentId
                const fetchTypes = containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined

                // Single round-trip: children + edges for search results.
                // The backend filters the parent's FULL child set by searchQuery
                // (not the loaded subset), so this is global within the subtree.
                // limit=200 is the match-count cap: ensures wide queries against
                // 1000+ children still surface a useful spread of results.
                const result = await provider.getChildrenWithEdges(urn, {
                    edgeTypes: fetchTypes,
                    lineageEdgeTypes: lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined,
                    searchQuery: query,
                    limit: 200,
                    includeLineageEdges: true,
                })

                if (signal.aborted) return

                // Get freshest state right before mutating
                const freshNodes = useCanvasStore.getState().nodes
                const freshEdges = useCanvasStore.getState().edges

                // Clean up existing children of this node to replace with search results
                const existingEdgesToRemove = freshEdges.filter(e => e.source === parentId)
                const targetNodeIdsToRemove = new Set(existingEdgesToRemove.map(e => e.target))

                // Keep nodes connected to other parents
                const otherEdges = freshEdges.filter(e => e.source !== parentId)
                const safeNodesToKeep = new Set(otherEdges.map(e => e.target))
                const nodeIdsToRemove = Array.from(targetNodeIdsToRemove).filter(id => !safeNodesToKeep.has(id))
                const edgeIdsToRemove = existingEdgesToRemove.map(e => e.id)

                if (nodeIdsToRemove.length > 0) removeNodes(nodeIdsToRemove)
                if (edgeIdsToRemove.length > 0) removeEdges(edgeIdsToRemove)

                if (result.children.length > 0) {
                    const nodesToAdd: LineageNode[] = []

                    const remainingNodeIds = new Set(freshNodes.map(n => n.id))
                    nodeIdsToRemove.forEach(id => remainingNodeIds.delete(id))
                    const newIds = new Set<string>()

                    result.children.forEach(child => {
                        if (!remainingNodeIds.has(child.urn) && !newIds.has(child.urn)) {
                            nodesToAdd.push(toCanvasNode(child))
                            newIds.add(child.urn)
                        }
                    })

                    const edgesToAdd = [
                        ...result.containmentEdges,
                        ...result.lineageEdges,
                    ].map(e => toCanvasEdge(e))

                    addGraph(nodesToAdd, edgesToAdd)
                }
            } catch (err) {
                console.error(`[useGraphHydration] Failed to search children for ${parentId}`, err)
            } finally {
                setLoadingNodes(prev => {
                    const next = new Set(prev)
                    next.delete(parentId)
                    return next
                })
            }
        })
    }, [provider, containmentEdgeTypes, lineageEdgeTypes])

    return {
        loadChildren,
        searchChildren,
        cancelChildLoad,
        isLoading: loadingNodes.size > 0,
        loadingNodes,
        failedNodes,
        hydrationPhase,
        hydrationError,
        hydrationStatus,
    }
}
