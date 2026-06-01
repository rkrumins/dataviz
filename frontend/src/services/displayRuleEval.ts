/**
 * displayRuleEval — evaluate a Property Manager display rule against the
 * current view and return the URNs of matching nodes.
 *
 * This is a thin, side-effect-free sibling of
 * ``useAdvancedSearch.runPredicate``: it builds a view-scoped
 * ``SearchQuery`` from a predicate and calls
 * ``RemoteGraphProvider.searchAdvanced`` directly. Crucially it does NOT
 * touch ``searchStore`` — display rules drive their own tag overlay
 * (``displayRuleMatchStore``) and must stay independent of the live
 * Advanced-Search highlight/spotlight so the two features never fight
 * over the canvas.
 *
 * Scope is mirrored from ``stampScope``: we run in ``'view'`` mode with
 * ``scope.rootUrns`` set to the canvas's computed view roots (or the
 * explicit layer assignment URNs when present) so a rule matches the
 * whole view subtree, including collapsed branches — not just the
 * nodes currently rendered.
 */
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import type { Predicate, SearchQuery, SearchResultPage, SearchScope } from '@/types/search'

import { computeViewRootUrns } from '@/components/canvas/search/panel/useCanvasViewRoots'


/** Backend default scope-root cap (DEEP_SEARCH_SCOPE_ROOT_URNS_CAP). */
const SAFE_ROOT_URN_CAP = 256

/** Page size for rule evaluation. Display rules want the FULL match set
 *  for the tag overlay, so we ask for a large page in one round-trip
 *  rather than paginating. Bounded by the backend candidate cap. */
const RULE_PAGE_SIZE = 1000


/** Collect every matched node URN from a result page. Mirrors
 *  ``collectMatchUrns`` in useAdvancedSearch — hits + aggregate sample
 *  hits. Display rules never run in path mode, so paths are ignored. */
function collectMatchUrns(result: SearchResultPage): string[] {
    const urns: string[] = []
    for (const hit of result.hits ?? []) {
        const u = hit.node?.urn
        if (u) urns.push(u)
    }
    for (const facet of result.aggregates ?? []) {
        for (const bucket of facet) {
            for (const hit of bucket.sampleHits ?? []) {
                const u = hit.node?.urn
                if (u) urns.push(u)
            }
        }
    }
    return urns
}


/**
 * Build a view-scoped SearchQuery for an arbitrary predicate + options.
 * Reads live canvas + schema + layer state via ``getState()`` (no hooks)
 * so it can run from anywhere — including outside React. Shared by the
 * display-rule evaluator and the property-insights service so both scope
 * identically.
 */
export function buildViewScopedQuery(
    viewId: string,
    predicate: Predicate,
    options: SearchQuery['options'],
): SearchQuery {
    const canvas = useCanvasStore.getState()
    const schema = useSchemaStore.getState().schema

    // Prefer explicit layer assignment URNs (closed-scope override —
    // same precedence as stampScope); fall back to computed view roots.
    const layers = useReferenceModelStore.getState().layers
    const explicitAssignmentUrns: string[] = []
    for (const layer of layers) {
        for (const a of layer.entityAssignments ?? []) {
            if (a.entityId) explicitAssignmentUrns.push(a.entityId)
        }
    }
    const allRootUrns = explicitAssignmentUrns.length > 0
        ? explicitAssignmentUrns
        : computeViewRootUrns(
            canvas.nodes,
            canvas.edges,
            schema?.containmentEdgeTypes ?? [],
            schema?.rootEntityTypes ?? [],
        )
    const rootUrns = allRootUrns.slice(0, SAFE_ROOT_URN_CAP)

    const scope: SearchScope = {
        viewId,
        scopeMode: 'view',
        ...(rootUrns.length > 0 ? { rootUrns } : {}),
    }

    // The backend predicate compiler mishandles bare top-level leaf
    // predicates — wrap leaves in a single-child AND group (mirrors
    // stampScope's defensive normalisation).
    const wrapped: Predicate = predicate.kind === 'group'
        ? predicate
        : { kind: 'group', op: 'and', children: [predicate] }

    return { predicate: wrapped, scope, options }
}


/**
 * Build the view-scoped SearchQuery for a display-rule predicate.
 */
function buildRuleQuery(viewId: string, predicate: Predicate): SearchQuery {
    return buildViewScopedQuery(viewId, predicate, {
        results: 'hits',
        pageSize: RULE_PAGE_SIZE,
        includeAncestorPath: false,
    })
}


/**
 * Evaluate a single display-rule predicate and return matching node
 * URNs. Resolves to ``[]`` when the active provider isn't the remote
 * backend (advanced search only works against the live API).
 */
export async function evaluateDisplayRule(
    provider: GraphDataProvider,
    viewId: string,
    predicate: Predicate,
    signal?: AbortSignal,
): Promise<string[]> {
    if (!(provider instanceof RemoteGraphProvider)) return []
    if (!viewId) return []
    const query = buildRuleQuery(viewId, predicate)
    const result = await provider.searchAdvanced(query)
    if (signal?.aborted) return []
    return collectMatchUrns(result)
}
