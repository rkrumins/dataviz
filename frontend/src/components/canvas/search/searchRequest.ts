/**
 * searchRequest — the one place a search request is put together, so every
 * surface that shows or sends one agrees: the run itself
 * (``useAdvancedSearch``), the Cypher tab and the compiled-query status bar
 * (both through ``useCompiledQuery``). What the Cypher tab shows is then
 * exactly what runs — the same scope, options, candidate cap and LIMIT.
 */
import { useCanvasStore } from '@/store/canvas'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchQuery, SearchScope } from '@/types/search'


/** The scope a search in ``viewId`` runs in, read now: how wide (the view,
 *  what's on the canvas, the whole data source) and, on the canvas, which
 *  entities. ``base`` — a template's own scope — is kept underneath. */
export function currentScope(viewId: string, base?: Partial<SearchScope>): SearchScope {
    const scopeMode = useSearchStore.getState().scopeMode
    // Always attach the canvas's URNs in visible mode, so the server never
    // has to guess them.
    const visibleUrns = scopeMode === 'visible'
        ? Array.from(new Set(
            useCanvasStore.getState().nodes
                .map((n) => n.id ?? n.data?.urn)
                .filter((u): u is string => typeof u === 'string' && u.length > 0),
        ))
        : undefined
    // No rootUrns hint for the view itself: the server resolves the view's
    // roots from ``scope.viewId`` and only ever intersects a client hint
    // with them.
    return {
        ...(base ?? {}),
        viewId,
        scopeMode,
        ...(visibleUrns ? { visibleUrns } : {}),
    }
}


/** ``predicate`` as a request carries it. The compiler mishandles a bare
 *  top-level leaf (text / isOrphan / isLeaf / …: zero results where the
 *  same leaf in a group finds them), so a leaf rides in a one-child AND. */
export function requestPredicate(predicate: Predicate): Predicate {
    return predicate.kind === 'group'
        ? predicate
        : { kind: 'group', op: 'and', children: [predicate] }
}


/** The request a search in ``viewId`` sends for ``predicate`` with
 *  ``options``. */
export function buildSearchRequest(
    predicate: Predicate, options: SearchQuery['options'], viewId: string,
): SearchQuery {
    return { predicate: requestPredicate(predicate), scope: currentScope(viewId), options }
}
