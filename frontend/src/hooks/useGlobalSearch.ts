import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listViews, type View } from '@/services/viewApiService'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import { useDashboardData, type TemplateBrief, type OntologyBrief } from './useDashboardData'
import { scoreCandidates, type FieldSpec } from '@/utils/searchScoring'

export type SearchCategory = 'Workspace' | 'Data Source' | 'View' | 'Template' | 'Semantic Layer'

export const CATEGORY_ORDER: SearchCategory[] = [
    'Workspace',
    'Data Source',
    'View',
    'Template',
    'Semantic Layer',
]

interface BaseHit {
    id: string
    category: SearchCategory
    name: string
    description?: string
    score: number
}

export interface WorkspaceHit extends BaseHit {
    category: 'Workspace'
    workspace: WorkspaceResponse
}

export interface DataSourceHit extends BaseHit {
    category: 'Data Source'
    workspace: WorkspaceResponse
    dataSource: DataSourceResponse
}

export interface ViewHit extends BaseHit {
    category: 'View'
    view: View
}

export interface TemplateHit extends BaseHit {
    category: 'Template'
    template: TemplateBrief
}

export interface OntologyHit extends BaseHit {
    category: 'Semantic Layer'
    ontology: OntologyBrief
}

export type SearchHit =
    | WorkspaceHit
    | DataSourceHit
    | ViewHit
    | TemplateHit
    | OntologyHit

export interface GlobalSearchResult {
    /** The trimmed query that produced these results. May lag the latest input by debounce delay. */
    query: string
    /** True while the debounced query differs from input or the views API is fetching. */
    isLoading: boolean
    /** Hits per category, capped at `limitPerCategory`, score-ordered. */
    byCategory: Record<SearchCategory, SearchHit[]>
    /** Pre-cap totals per category (used for "Show all N"). */
    totalByCategory: Record<SearchCategory, number>
}

const VIEW_FETCH_LIMIT = 50

const WORKSPACE_FIELDS: FieldSpec<WorkspaceResponse>[] = [
    { get: w => w.name, weight: 1.0 },
    { get: w => w.description, weight: 0.4 },
]

const VIEW_FIELDS: FieldSpec<View>[] = [
    { get: v => v.name, weight: 1.0 },
    { get: v => v.description, weight: 0.4 },
    { get: v => v.tags, weight: 0.6 },
    { get: v => v.workspaceName, weight: 0.3 },
]

const TEMPLATE_FIELDS: FieldSpec<TemplateBrief>[] = [
    { get: t => t.name, weight: 1.0 },
    { get: t => t.description, weight: 0.4 },
    { get: t => t.category, weight: 0.3 },
]

const ONTOLOGY_FIELDS: FieldSpec<OntologyBrief>[] = [
    { get: o => o.name, weight: 1.0 },
    { get: o => o.description, weight: 0.4 },
]

interface DataSourceWithContext {
    workspace: WorkspaceResponse
    dataSource: DataSourceResponse
}

const DATA_SOURCE_FIELDS: FieldSpec<DataSourceWithContext>[] = [
    { get: x => x.dataSource.label, weight: 1.0 },
    { get: x => x.workspace.graphName ?? null, weight: 0.5 },
    { get: x => x.dataSource.id, weight: 0.2 },
]

/** Tiny inline debounce — no shared util exists in the codebase yet. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delayMs)
        return () => clearTimeout(t)
    }, [value, delayMs])
    return debounced
}

/**
 * Unified ranked search across views, workspaces, data sources, templates,
 * and ontologies. Used by both the Dashboard hero and the Command Palette.
 *
 * - Views: backend-search via `GET /api/v1/views?search=` (debounced, cached
 *   per query string). This is the critical fix — both Dashboard and Palette
 *   used to filter only their in-memory subsets, missing any view not in
 *   the active schema/recent list.
 * - Everything else: ranked client-side from `useDashboardData()`, which
 *   already loads workspaces / templates / ontologies into the dashboard.
 */
export function useGlobalSearch(
    rawQuery: string,
    options: { limitPerCategory?: number } = {}
): GlobalSearchResult {
    const limitPerCategory = options.limitPerCategory ?? 8
    const trimmed = rawQuery.trim()
    const debouncedQuery = useDebouncedValue(trimmed, 150)

    const { workspaces, templates, ontologies } = useDashboardData()

    const viewsQuery = useQuery({
        queryKey: ['globalSearch', 'views', debouncedQuery],
        queryFn: () => listViews({ search: debouncedQuery, limit: VIEW_FETCH_LIMIT }),
        enabled: debouncedQuery.length > 0,
        staleTime: 30_000,
    })

    return useMemo<GlobalSearchResult>(() => {
        const empty = emptyResult(trimmed)
        if (!debouncedQuery) return empty

        // Workspaces ─────────────────────────────────────────────────────
        const wsScored = scoreCandidates(workspaces ?? [], debouncedQuery, WORKSPACE_FIELDS)
        const workspaceHits: WorkspaceHit[] = wsScored.map(({ item, score }) => ({
            id: `ws-${item.id}`,
            category: 'Workspace',
            name: item.name,
            description: item.description,
            score,
            workspace: item,
        }))

        // Data sources (flatten across workspaces) ───────────────────────
        const dsCandidates: DataSourceWithContext[] = (workspaces ?? []).flatMap(ws =>
            (ws.dataSources ?? []).map(ds => ({ workspace: ws, dataSource: ds }))
        )
        const dsScored = scoreCandidates(dsCandidates, debouncedQuery, DATA_SOURCE_FIELDS)
        const dataSourceHits: DataSourceHit[] = dsScored.map(({ item, score }) => ({
            id: `ds-${item.dataSource.id}`,
            category: 'Data Source',
            name: item.dataSource.label ?? item.dataSource.id,
            description: `Data source in ${item.workspace.name}`,
            score,
            workspace: item.workspace,
            dataSource: item.dataSource,
        }))

        // Views (from API search results) ────────────────────────────────
        const viewItems = viewsQuery.data?.items ?? []
        const viewScored = scoreCandidates(viewItems, debouncedQuery, VIEW_FIELDS)
        const viewHits: ViewHit[] = viewScored.map(({ item, score }) => ({
            id: `view-${item.id}`,
            category: 'View',
            name: item.name,
            description: item.description ?? `${item.viewType} view${item.workspaceName ? ` in ${item.workspaceName}` : ''}`,
            score,
            view: item,
        }))

        // Templates ──────────────────────────────────────────────────────
        const tplScored = scoreCandidates(templates, debouncedQuery, TEMPLATE_FIELDS)
        const templateHits: TemplateHit[] = tplScored.map(({ item, score }) => ({
            id: `tpl-${item.id}`,
            category: 'Template',
            name: item.name,
            description: item.description,
            score,
            template: item,
        }))

        // Ontologies / Semantic Layers ───────────────────────────────────
        const ontScored = scoreCandidates(ontologies, debouncedQuery, ONTOLOGY_FIELDS)
        const ontologyHits: OntologyHit[] = ontScored.map(({ item, score }) => ({
            id: `sl-${item.id}`,
            category: 'Semantic Layer',
            name: item.name,
            description: item.description ?? (item.version != null ? `v${item.version}` : undefined),
            score,
            ontology: item,
        }))

        const totalByCategory: Record<SearchCategory, number> = {
            Workspace: workspaceHits.length,
            'Data Source': dataSourceHits.length,
            View: viewHits.length,
            Template: templateHits.length,
            'Semantic Layer': ontologyHits.length,
        }

        const byCategory: Record<SearchCategory, SearchHit[]> = {
            Workspace: workspaceHits.slice(0, limitPerCategory),
            'Data Source': dataSourceHits.slice(0, limitPerCategory),
            View: viewHits.slice(0, limitPerCategory),
            Template: templateHits.slice(0, limitPerCategory),
            'Semantic Layer': ontologyHits.slice(0, limitPerCategory),
        }

        const isStale = trimmed !== debouncedQuery
        return {
            query: debouncedQuery,
            isLoading: isStale || viewsQuery.isFetching,
            byCategory,
            totalByCategory,
        }
    }, [debouncedQuery, trimmed, workspaces, templates, ontologies, viewsQuery.data, viewsQuery.isFetching, limitPerCategory])
}

/** Flattens hits in canonical category order for consumers that want a single list. */
export function flattenHits(result: GlobalSearchResult): SearchHit[] {
    const out: SearchHit[] = []
    for (const cat of CATEGORY_ORDER) out.push(...result.byCategory[cat])
    return out
}

function emptyResult(query: string): GlobalSearchResult {
    const empty: Record<SearchCategory, SearchHit[]> = {
        Workspace: [],
        'Data Source': [],
        View: [],
        Template: [],
        'Semantic Layer': [],
    }
    const zeros: Record<SearchCategory, number> = {
        Workspace: 0,
        'Data Source': 0,
        View: 0,
        Template: 0,
        'Semantic Layer': 0,
    }
    return {
        query,
        isLoading: false,
        byCategory: empty,
        totalByCategory: zeros,
    }
}
