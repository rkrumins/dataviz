/**
 * State machine + provider orchestration for the SearchMapPanel.
 *
 * Three responsibilities:
 *   1. Hold the current view: idle → templateSelected → running → results,
 *      with the active template inputs / parsed query alongside.
 *   2. Talk to the backend through RemoteGraphProvider.searchAdvanced,
 *      with abort-on-restart so a stale request can never overwrite a
 *      fresh one (e.g. user re-runs while a slow query is still in flight).
 *   3. Track the scope drill stack — when the user clicks "Drill into
 *      Customers", we push a scope frame; the breadcrumb pops it.
 *
 * Drill semantics: every drill re-issues the same predicate with
 * `scope.rootUrns` set to the bucket's `ancestorUrn`. The hit
 * subtree is the new universe; the same template applies inside it.
 * This is the "orient before drill" UX from the brief.
 *
 * Not stored: the raw-JSON / Explain / Discover surfaces — those live
 * in the SearchMapPanel's "Power tools" tab and share the same query
 * pipeline through `runPredicate`. The hook stays focused on
 * template-driven + visual-builder paths.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { DEFAULT_DRAFT_OPTIONS, useSearchStore, type AncestorPathInfo } from '@/store/searchStore'
import type {
    AncestorRef,
    Predicate,
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
import { computeViewRootUrns } from '@/components/canvas/search/panel/useCanvasViewRoots'


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

/** One frame on the drill stack — used to render the scope breadcrumb. */
export interface ScopeFrame {
    /** URN of the ancestor we drilled into. Empty string at the root. */
    urn: string
    /** Human-readable label for the breadcrumb. */
    label: string
    /** Entity type, used to colour-tint the breadcrumb chip. */
    entityType: string
}

const ROOT_FRAME: ScopeFrame = { urn: '', label: 'All', entityType: '' }


export interface UseAdvancedSearchResult {
    view: PanelView
    scope: ScopeFrame[]
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
     *  Bypasses the template form: stamps view scope + drill frame,
     *  dispatches through the same running → results state machine.
     *  Optional ``optionsOverride`` lets free-form searches opt out of
     *  the default aggregation (so a 49-hit search renders 49 rows, not
     *  one bucket containing 49). */
    runPredicate: (predicate: Predicate,
                   optionsOverride?: SearchQuery['options']) => Promise<void>
    /** Drill into an aggregate bucket — pushes a scope frame and re-runs. */
    drillInto: (bucket: { ancestorUrn: string; ancestorDisplayName: string;
                          ancestorEntityType: string }) => void
    /** Pop scope frames to the given index (0 = root). */
    popScope: (toIndex: number) => void
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
 */
export function useAdvancedSearch(viewId: string): UseAdvancedSearchResult {
    const provider = useGraphProvider()
    const [view, setView] = useState<PanelView>({ kind: 'idle' })
    const [scope, setScope] = useState<ScopeFrame[]>([ROOT_FRAME])
    const abortRef = useRef<AbortController | null>(null)

    // Cancel any in-flight request when the hook unmounts (panel closed
    // mid-query). Otherwise the resolved promise would set state on an
    // unmounted component. Also clear the cross-component result-set so
    // the canvas stops highlighting matches once the panel goes away.
    useEffect(() => () => {
        abortRef.current?.abort()
        useSearchStore.getState().clear()
    }, [])

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
        setView({ kind: 'idle' })
    }, [])

    const stampScope = useCallback(
        (template: SearchTemplate, inputs: Record<string, string | number>,
         scopeStack: ScopeFrame[] | null): SearchQuery => {
            const raw = template.build(inputs)
            // ALWAYS stamp the viewId — the backend's ViewScopeResolver
            // requires it on every request. If the user has drilled
            // (non-root scope frames), additionally pass the current
            // ancestor URN as a narrowing hint via scope.rootUrns; the
            // resolver intersects it with the view's allowed roots.
            const drillFrame = scopeStack
                ? scopeStack[scopeStack.length - 1]
                : null
            const scopeMode = useSearchStore.getState().scopeMode

            // Read live canvas + schema state at call time so we don't
            // capture stale closures.
            const canvas = useCanvasStore.getState()
            const schema = useSchemaStore.getState().schema

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

            // Compute the canvas's "view roots" — the top-level
            // containers that define the view's boundary. Used as the
            // scope.rootUrns hint when the user is in 'view' mode and
            // the view's persisted rootUrns are empty (otherwise the
            // BE skips the containment clamp entirely and returns
            // results from outside the view — the "Legacy_Archive
            // leaking in" bug).
            //
            // CLOSED-SCOPE OVERRIDE: when the view config carries
            // explicit ``entityAssignments`` (i.e. the user dragged
            // specific entities into layers via the Layer Studio),
            // those URNs ARE the authoritative scope. The BE's
            // ``scope.rootUrns`` includes the URN + all containment
            // descendants, so passing the assignment URNs gives us
            // exactly the same closed scope the canvas renders.
            // Without this override, ``computeViewRootUrns`` walks
            // the loaded canvas nodes and includes top-level
            // containers like the Sales domain even when Sales isn't
            // assigned to any layer — leaking unassigned subtrees
            // into "All nodes in this view" search results. Mirrors
            // the closed-scope semantics in useLayerAssignment.
            const layerAssignments = useReferenceModelStore.getState().layers
            const explicitAssignmentUrns: string[] = []
            for (const layer of layerAssignments) {
                if (!layer.entityAssignments) continue
                for (const a of layer.entityAssignments) {
                    if (a.entityId) explicitAssignmentUrns.push(a.entityId)
                }
            }
            const allCanvasRootUrns = explicitAssignmentUrns.length > 0
                ? explicitAssignmentUrns
                : computeViewRootUrns(
                    canvas.nodes,
                    canvas.edges,
                    schema?.containmentEdgeTypes ?? [],
                    schema?.rootEntityTypes ?? [],
                )

            // Client-side safety net: cap matches the BE default
            // (DEEP_SEARCH_SCOPE_ROOT_URNS_CAP=256). If the view has
            // more top-level containers than this, we truncate
            // client-side rather than letting the BE 422. The diagnostic
            // surfaces the truncation so the user sees they're not
            // searching the full set.
            const SAFE_ROOT_URN_CAP = 256
            const wasTruncated = allCanvasRootUrns.length > SAFE_ROOT_URN_CAP
            const canvasRootUrns = wasTruncated
                ? allCanvasRootUrns.slice(0, SAFE_ROOT_URN_CAP)
                : allCanvasRootUrns
            if (wasTruncated) {
                // One-shot console warning (production hardening — the
                // diagnostic in ZeroResultsDiagnostic is the primary
                // user-facing channel; the console line helps support).
                // eslint-disable-next-line no-console
                console.warn(
                    `[advancedSearch] view has ${allCanvasRootUrns.length} `
                    + `top-level containers; truncating to ${SAFE_ROOT_URN_CAP}. `
                    + 'Switch to "Entire data source" or raise '
                    + 'DEEP_SEARCH_SCOPE_ROOT_URNS_CAP to reach the rest.',
                )
            }

            // Precedence for scope.rootUrns:
            //   1. Drill frame (highest priority — user drilled into
            //      a specific bucket; honour their selection).
            //   2. Raw.scope.rootUrns (caller-supplied — e.g. a
            //      template that targets a specific URN).
            //   3. Canvas view roots (the "in this view" boundary).
            //
            // Only attaches roots when scope_mode is 'view' or 'visible'
            // — 'data_source' explicitly opts out of any clamp.
            const explicitRoots = (raw.scope as { rootUrns?: string[] } | undefined)?.rootUrns
            let rootUrns: string[] | undefined
            if (drillFrame && drillFrame.urn) {
                rootUrns = [drillFrame.urn]
            } else if (explicitRoots && explicitRoots.length > 0) {
                rootUrns = explicitRoots
            } else if (
                scopeMode !== 'data_source'
                && canvasRootUrns.length > 0
            ) {
                rootUrns = canvasRootUrns
            }

            const scope: SearchScope = {
                ...(raw.scope ?? {}),
                viewId,
                scopeMode,
                ...(visibleUrns ? { visibleUrns } : {}),
                ...(rootUrns ? { rootUrns } : {}),
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
        scopeStack: ScopeFrame[],
    ) => {
        if (!(provider instanceof RemoteGraphProvider)) {
            setView({
                kind: 'error', template, inputs,
                query: stampScope(template, inputs, null),
                message:
                    'Active provider is not the remote backend — ' +
                    'advanced search only works against the live API.',
                elapsedMs: 0,
            })
            return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const query = stampScope(template, inputs, scopeStack)
        const startedAt = performance.now()
        setView({ kind: 'running', template, inputs, query, startedAt })

        try {
            const result = await provider.searchAdvanced(query)
            if (controller.signal.aborted) return
            setView({
                kind: 'results', template, inputs, query, result,
                elapsedMs: Math.round(performance.now() - startedAt),
            })
            // Publish the match URN set so the ContextView canvas
            // (W3 — useSearchHighlight + SearchPinOverlay +
            // ChevronMatchBadge) can react. JSON.stringify is
            // deterministic enough for the consumer's "did the query
            // change?" check; a real fingerprint can replace it if
            // ordering ever becomes an issue.
            useSearchStore.getState().setResult({
                viewId,
                matchUrns: collectMatchUrns(result),
                ancestorPaths: collectAncestorPaths(result),
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
            // On error, drop any previously-published result-set so the
            // canvas doesn't keep highlighting stale matches.
            useSearchStore.getState().clear()
        }
    }, [provider, stampScope, viewId])

    const run = useCallback(async () => {
        if (view.kind === 'idle' || view.kind === 'running') return
        await runWithInputs(view.template, view.inputs, scope)
    }, [view, scope, runWithInputs])

    const runTemplate = useCallback(
        async (template: SearchTemplate,
               inputs?: Record<string, string | number>) => {
            await runWithInputs(template, inputs ?? defaultInputs(template), scope)
        },
        [scope, runWithInputs],
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
        await runWithInputs(syntheticTemplate, {}, scope)
    }, [scope, runWithInputs])

    const drillInto = useCallback((bucket: {
        ancestorUrn: string
        ancestorDisplayName: string
        ancestorEntityType: string
    }) => {
        if (view.kind !== 'results') return
        const nextScope: ScopeFrame[] = [
            ...scope,
            {
                urn: bucket.ancestorUrn,
                label: bucket.ancestorDisplayName,
                entityType: bucket.ancestorEntityType,
            },
        ]
        setScope(nextScope)
        // Re-run the same template + inputs but now scoped to the
        // bucket. The stampScope helper injects scope.rootUrns.
        void runWithInputs(view.template, view.inputs, nextScope)
    }, [view, scope, runWithInputs])

    const popScope = useCallback((toIndex: number) => {
        const clamped = Math.max(0, Math.min(toIndex, scope.length - 1))
        if (clamped === scope.length - 1) return
        const nextScope = scope.slice(0, clamped + 1)
        setScope(nextScope)
        // If we have a query in flight or showing, re-run it at the
        // new scope so the displayed buckets/hits match the breadcrumb.
        if (view.kind === 'results' || view.kind === 'error') {
            void runWithInputs(view.template, view.inputs, nextScope)
        }
    }, [scope, view, runWithInputs])

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
            const nextPage = await provider.searchAdvanced(nextQuery)
            // Merge: append new hits, replace cursor (may now be null
            // signalling "no more pages"), keep aggregates from p1.
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
                queryHash: JSON.stringify(view.query),
            })
        } catch (e) {
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

    return {
        view,
        scope,
        isIdle: view.kind === 'idle',
        selectTemplate,
        setInput,
        resetTemplate,
        run,
        runTemplate,
        runPredicate,
        drillInto,
        popScope,
        cancel,
        loadMore,
        isLoadingMore,
    }
}
