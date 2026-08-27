/**
 * stampViewScope — put a raw SearchQuery inside the boundary of a view.
 *
 * Extracted verbatim from ``useAdvancedSearch.stampScope`` so the
 * Context View header's find-in-view box and the Advanced Search rail
 * resolve "this view" identically. Two definitions of a search's
 * boundary would be two different answers to the same question, and the
 * one the user sees would depend on which box they typed into.
 *
 * Reads live canvas / schema / reference-model state at call time rather
 * than closing over it, so a caller can't dispatch against a stale
 * canvas.
 *
 * This clamp is only a NARROWING HINT. The backend's ViewScopeResolver
 * enforces the view boundary server-side on every request, so dropping
 * the hint costs candidate-set width and can never widen what a user is
 * allowed to see.
 */
import { computeViewRootUrns } from './useCanvasViewRoots'

import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { useSearchStore } from '@/store/searchStore'
import type { SearchQuery, SearchScope } from '@/types/search'


/** Client-side safety net matching the BE's
 *  DEEP_SEARCH_SCOPE_ROOT_URNS_CAP (5000). Past the cap we DROP the hint
 *  rather than truncate it: a truncated list silently hides real matches,
 *  which reads to the user as "search randomly can't find things". */
const SAFE_ROOT_URN_CAP = 5000

export type ScopeMode = 'visible' | 'view' | 'data_source'

/** What callers hand in: a query that has not been placed in a view yet.
 *  ``viewId`` is this function's job, and callers may omit ``scope``
 *  entirely or supply only the parts they care about (a template's
 *  ``entityTypes``, find-in-view's container ``rootUrns``). Structurally
 *  identical to ``searchTemplates.TemplateSearchQuery``. */
export type ScopableSearchQuery = Omit<SearchQuery, 'scope'> & {
    scope?: Omit<SearchScope, 'viewId'>
}


export function stampViewScope(
    raw: ScopableSearchQuery,
    viewId: string,
    /** Overrides the rail's persisted ``scopeMode``. Find-in-view passes
     *  ``'view'`` so a user who last left the rail on ``'visible'``
     *  doesn't silently get loaded-only results in the header box. */
    scopeModeOverride?: ScopeMode,
): SearchQuery {
    // ALWAYS stamp the viewId — the backend's ViewScopeResolver requires
    // it on every request.
    const scopeMode = scopeModeOverride ?? useSearchStore.getState().scopeMode

    const canvas = useCanvasStore.getState()
    const schema = useSchemaStore.getState().schema

    // Collect the visible URN set straight from the canvas store. Always
    // attach when mode='visible' so the backend doesn't have to guess.
    const visibleUrns = scopeMode === 'visible'
        ? Array.from(new Set(
            canvas.nodes
                .map((n) => n.id ?? n.data?.urn)
                .filter((u): u is string => typeof u === 'string' && u.length > 0),
        ))
        : undefined

    // Compute the canvas's "view roots" — the top-level containers that
    // define the view's boundary. Used as the scope.rootUrns hint when
    // the user is in 'view' mode and the view's persisted rootUrns are
    // empty (otherwise the BE skips the containment clamp entirely and
    // returns results from outside the view — the "Legacy_Archive
    // leaking in" bug).
    //
    // CLOSED-SCOPE OVERRIDE: when the view config carries explicit
    // ``entityAssignments`` (i.e. the user dragged specific entities
    // into layers via the Layer Studio), those URNs ARE the
    // authoritative scope. The BE's ``scope.rootUrns`` includes the URN
    // + all containment descendants, so passing the assignment URNs
    // gives us exactly the same closed scope the canvas renders. Without
    // this override, ``computeViewRootUrns`` walks the loaded canvas
    // nodes and includes top-level containers like the Sales domain even
    // when Sales isn't assigned to any layer — leaking unassigned
    // subtrees into "All nodes in this view" search results. Mirrors the
    // closed-scope semantics in useLayerAssignment.
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

    const canvasRootUrns = allCanvasRootUrns.length > SAFE_ROOT_URN_CAP
        ? []
        : allCanvasRootUrns
    if (allCanvasRootUrns.length > SAFE_ROOT_URN_CAP) {
        console.warn(
            `[advancedSearch] view has ${allCanvasRootUrns.length} `
            + `top-level containers, over the ${SAFE_ROOT_URN_CAP} cap; `
            + 'searching without the client-side root hint. The view '
            + 'boundary is still enforced server-side.',
        )
    }

    // Precedence for scope.rootUrns:
    //   1. Raw.scope.rootUrns (caller-supplied — e.g. a template that
    //      targets a specific URN, or find-in-view scoped to one
    //      container the user focused).
    //   2. Canvas view roots (the "in this view" boundary).
    //
    // Only attaches roots when scope_mode is 'view' or 'visible' —
    // 'data_source' explicitly opts out of any clamp.
    const explicitRoots = (raw.scope as { rootUrns?: string[] } | undefined)?.rootUrns
    let rootUrns: string[] | undefined
    if (explicitRoots && explicitRoots.length > 0) {
        rootUrns = explicitRoots
    } else if (scopeMode !== 'data_source' && canvasRootUrns.length > 0) {
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
    // currently mishandles bare top-level leaf predicates (text /
    // isOrphan / isLeaf / …) — they evaluate to zero results even when
    // an equivalent group-wrapped version returns the expected hits.
    // Wrap leaf-rooted predicates in a single-child AND group so every
    // outgoing request has the shape the compiler is happy with. No-op
    // when the root is already a group.
    const predicate = raw.predicate.kind === 'group'
        ? raw.predicate
        : { kind: 'group' as const, op: 'and' as const,
            children: [raw.predicate] }

    return { ...raw, predicate, scope }
}
