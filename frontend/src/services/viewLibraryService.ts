/**
 * viewLibraryService — a view's library on the server: its display rules
 * (a draft's own on its branch), its saved queries, its bulk recipes, and
 * the pack the rules and queries are exported and imported in. Backend:
 * ``/api/v1/views/{id}/library`` (``backend/app/api/v1/endpoints/views.py``).
 *
 * Rules are written one at a time: each call writes only the rule it names
 * and answers with the view's rules as they now stand, edits other people
 * made meanwhile included. Saved queries and recipes belong to the view,
 * whichever branch is open.
 */
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { authFetch } from './apiClient'
import type { PropertyJobOp, PropertyOpKind } from './versioningApiService'


export interface SavedViewQuery {
    id: string
    name: string
    description?: string | null
    predicate: Predicate
    createdAt?: string | null
    createdBy?: string | null
    updatedAt?: string | null
    updatedBy?: string | null
}

export interface SavedViewQueryInput {
    name: string
    description?: string | null
    predicate: Predicate
}

/** A query saved on another view of the workspace that the caller may open. */
export interface OtherViewQuery {
    viewId: string
    viewName: string
    /** The other view reads this one's data source, so the query's names,
     *  types and layers mean what they meant there. */
    sameSource: boolean
    query: SavedViewQuery
}

/** Which entities a recipe reaches, as the bulk dialog's Where step names
 *  them — never by id: run again, the entities picked then may not be the
 *  ones it should reach. A layer is kept by name, and found by it where the
 *  recipe runs. */
export type RecipeTarget =
    | { kind: 'view'; scopeMode?: 'view' | 'data_source' }
    | { kind: 'hasKey'; key: string; scopeMode?: 'view' | 'data_source' }
    | { kind: 'layer'; layerName: string; scopeMode?: 'view' }
    | { kind: 'search' | 'custom' | 'connections'; predicate: Predicate; scopeMode?: 'view' | 'data_source' }

/** A bulk property change kept under a name in a view's library, to run again. */
export interface BulkRecipe {
    id: string
    name: string
    description?: string | null
    /** The change, as a job keeps it — never an undo, which only undoes a change already made. */
    op: PropertyJobOp & { kind: PropertyOpKind }
    target: RecipeTarget
    createdAt?: string | null
    createdBy?: string | null
    updatedAt?: string | null
    updatedBy?: string | null
}

export interface BulkRecipeInput {
    name: string
    description?: string | null
    op: PropertyJobOp
    target: RecipeTarget
}

/** A recipe saved on another view of the workspace that the caller may open. */
export interface OtherViewRecipe {
    viewId: string
    viewName: string
    /** The other view reads this one's data source, so the recipe's keys,
     *  types and layers mean what they meant there. */
    sameSource: boolean
    recipe: BulkRecipe
}

export interface ViewLibrary {
    viewId: string
    branchId?: string | null
    displayRules: DisplayRuleConfig[]
    savedQueries: SavedViewQuery[]
    bulkRecipes?: BulkRecipe[]
    /** Whether the caller may change the library (the server's own check). */
    canEdit: boolean
}

export const LIBRARY_PACK_FORMAT = 'synodic.view-library'

/** A view's rules and saved queries, as a file to import into another view. */
export interface LibraryPack {
    format: typeof LIBRARY_PACK_FORMAT
    version: 1
    exportedAt?: string | null
    source?: { viewId?: string | null; viewName?: string | null; branchId?: string | null } | null
    displayRules?: unknown[]
    savedQueries?: unknown[]
}

/** ``merge`` adds what the view doesn't have, ``copy`` adds everything,
 *  ``replace`` removes the view's rules and queries first. */
export type ImportStrategy = 'merge' | 'replace' | 'copy'

export interface LibraryImportItem {
    kind: 'rule' | 'query'
    sourceId?: string | null
    name: string
    action: 'add' | 'skip' | 'refuse'
    /** The name it is added under, when that differs. */
    newName?: string | null
    reason?: string | null
    warnings: string[]
}

export interface LibraryImportResult {
    strategy: ImportStrategy
    dryRun: boolean
    items: LibraryImportItem[]
    added: number
    skipped: number
    refused: number
    /** Existing rules and queries a replace removes. */
    removed: number
    /** The library as it now stands — after a real import only. */
    library?: ViewLibrary | null
}


function libraryUrl(viewId: string, path = '', params: Record<string, string | null | undefined> = {}): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value) query.set(key, value)
    }
    const qs = query.toString()
    return `/api/v1/views/${viewId}/library${path}${qs ? `?${qs}` : ''}`
}


export function getViewLibrary(viewId: string, branchId?: string | null): Promise<ViewLibrary> {
    return authFetch<ViewLibrary>(libraryUrl(viewId, '', { branchId }))
}

/** Add a rule, or replace the one with its id where it stands. */
export function putViewRule(
    viewId: string, rule: DisplayRuleConfig, branchId?: string | null,
): Promise<DisplayRuleConfig[]> {
    return authFetch<DisplayRuleConfig[]>(
        libraryUrl(viewId, `/rules/${encodeURIComponent(rule.id)}`, { branchId }),
        { method: 'PUT', body: JSON.stringify(rule) },
    )
}

export function deleteViewRule(
    viewId: string, ruleId: string, branchId?: string | null,
): Promise<DisplayRuleConfig[]> {
    return authFetch<DisplayRuleConfig[]>(
        libraryUrl(viewId, `/rules/${encodeURIComponent(ruleId)}`, { branchId }),
        { method: 'DELETE' },
    )
}

/** Rules in the order ``ids`` names them; any it leaves out follow. */
export function orderViewRules(
    viewId: string, ids: string[], branchId?: string | null,
): Promise<DisplayRuleConfig[]> {
    return authFetch<DisplayRuleConfig[]>(libraryUrl(viewId, '/rules', { branchId }), {
        method: 'PUT', body: JSON.stringify({ ids }),
    })
}

export function putViewQuery(
    viewId: string, queryId: string, body: SavedViewQueryInput,
): Promise<SavedViewQuery> {
    return authFetch<SavedViewQuery>(libraryUrl(viewId, `/queries/${encodeURIComponent(queryId)}`), {
        method: 'PUT', body: JSON.stringify(body),
    })
}

export function deleteViewQuery(viewId: string, queryId: string): Promise<void> {
    return authFetch<void>(libraryUrl(viewId, `/queries/${encodeURIComponent(queryId)}`), {
        method: 'DELETE',
    })
}

/** The queries saved on the workspace's other views the caller may open —
 *  those over this view's data source first. */
export function listQueriesFromOtherViews(viewId: string, signal?: AbortSignal): Promise<OtherViewQuery[]> {
    return authFetch<OtherViewQuery[]>(libraryUrl(viewId, '/from-other-views'), { signal })
}

export function putViewRecipe(
    viewId: string, recipeId: string, body: BulkRecipeInput,
): Promise<BulkRecipe> {
    return authFetch<BulkRecipe>(libraryUrl(viewId, `/recipes/${encodeURIComponent(recipeId)}`), {
        method: 'PUT', body: JSON.stringify(body),
    })
}

export function deleteViewRecipe(viewId: string, recipeId: string): Promise<void> {
    return authFetch<void>(libraryUrl(viewId, `/recipes/${encodeURIComponent(recipeId)}`), {
        method: 'DELETE',
    })
}

/** The recipes saved on the workspace's other views the caller may open —
 *  those over this view's data source first. */
export function listRecipesFromOtherViews(viewId: string, signal?: AbortSignal): Promise<OtherViewRecipe[]> {
    return authFetch<OtherViewRecipe[]>(libraryUrl(viewId, '/recipes/from-other-views'), { signal })
}

export function exportViewLibrary(viewId: string, branchId?: string | null): Promise<LibraryPack> {
    return authFetch<LibraryPack>(libraryUrl(viewId, '/export', { branchId }))
}

/** What importing ``pack`` does, item by item (``dryRun``) — or do it. */
export function importViewLibrary(
    viewId: string,
    pack: LibraryPack,
    { strategy, dryRun, branchId }: { strategy: ImportStrategy; dryRun: boolean; branchId?: string | null },
): Promise<LibraryImportResult> {
    return authFetch<LibraryImportResult>(
        libraryUrl(viewId, '/import', { strategy, dryRun: String(dryRun), branchId }),
        { method: 'POST', body: JSON.stringify(pack) },
    )
}
