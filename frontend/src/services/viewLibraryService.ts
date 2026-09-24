/**
 * viewLibraryService — a view's library on the server: its display rules
 * (a draft's own on its branch), its saved queries, and the pack both are
 * exported and imported in. Backend: ``/api/v1/views/{id}/library``
 * (``backend/app/api/v1/endpoints/views.py``).
 *
 * Rules are written one at a time: each call writes only the rule it names
 * and answers with the view's rules as they now stand, edits other people
 * made meanwhile included. Saved queries belong to the view, whichever
 * branch is open.
 */
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { authFetch } from './apiClient'


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

export interface ViewLibrary {
    viewId: string
    branchId?: string | null
    displayRules: DisplayRuleConfig[]
    savedQueries: SavedViewQuery[]
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
