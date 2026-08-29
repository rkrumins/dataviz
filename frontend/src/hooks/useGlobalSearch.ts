import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listViews, type View } from '@/services/viewApiService'
import { useDebouncedValue } from './useDebouncedValue'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import { useDashboardData, type TemplateBrief, type OntologyBrief } from './useDashboardData'
import { useAnalyticsAccess } from './useAnalyticsAccess'
import { scoreCandidates, type FieldSpec } from '@/utils/searchScoring'
import { getIndex, runSearch, type DocsSearchArea } from '@/components/docs/search/useDocsSearchIndex'
import { interpolateBrand } from '@/lib/brandText'
import { PAGE_INDEX, pageAllowed, type PageEntry } from '@/lib/pageIndex'
import { usePermissionClaims } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { useNavCatalogueStore } from '@/store/navCatalogue'

export type SearchCategory =
    | 'Page'
    | 'Workspace'
    | 'Data Source'
    | 'View'
    | 'Template'
    | 'Semantic Layer'
    | 'Setting'
    | 'Doc'

/**
 * Reading order for every consumer. Pages lead because someone who types
 * a product word into the palette usually wants to GO there, and views
 * outrank workspaces because a view is what people open all day.
 * Settings and docs sit at the end: precise answers, rarely the first
 * thing you meant.
 */
export const CATEGORY_ORDER: SearchCategory[] = [
    'Page',
    'View',
    'Workspace',
    'Data Source',
    'Template',
    'Semantic Layer',
    'Setting',
    'Doc',
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

/**
 * A destination in the product itself. Pages and settings share one hit
 * type because they differ only in where they are listed; `path` is
 * ready for `navigate()`, `?tab=` deep link and all.
 */
export interface PageHit extends BaseHit {
    category: 'Page' | 'Setting'
    path: string
}

/** A passage of the in-app Documentation or User Guide. */
export interface DocHit extends BaseHit {
    category: 'Doc'
    area: DocsSearchArea
    slug: string
}

export type SearchHit =
    | PageHit
    | DocHit
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
    /** The server holds views beyond the page we fetched — offer Explorer. */
    viewsHasMore: boolean
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

// Keywords outrank the description: they are the words a person actually
// types for a screen whose title uses different ones ("permissions" for
// Roles, "login" for Connected identities).
const PAGE_FIELDS: FieldSpec<PageEntry>[] = [
    { get: e => e.title, weight: 1.0 },
    { get: e => e.keywords, weight: 0.6 },
    { get: e => e.description, weight: 0.4 },
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
 *
 * `appWide` adds the product itself — pages and settings this reader may
 * open, and the docs/guide full text. The Dashboard hero searches content
 * only and never passes it; the ⌘K palette always does.
 */
export function useGlobalSearch(
    rawQuery: string,
    options: { limitPerCategory?: number; appWide?: boolean } = {}
): GlobalSearchResult {
    const limitPerCategory = options.limitPerCategory ?? 8
    const appWide = options.appWide ?? false
    const trimmed = rawQuery.trim()
    const debouncedQuery = useDebouncedValue(trimmed, 150)

    const { workspaces, templates, ontologies } = useDashboardData()

    // Read unconditionally — rules of hooks, and each is one store slice.
    // Only the filtering below is skipped for a content-only caller.
    const claims = usePermissionClaims()
    const sidebar = useNavCatalogueStore(s => s.sidebar)
    const adminSections = useNavCatalogueStore(s => s.adminSections)
    const analyticsAllowed = useAnalyticsAccess().allowed
    const brand = useBrand()

    // The palette must offer no door that then slams: same catalogue
    // specs, same predicate, as the route guards.
    const visiblePages = useMemo(
        () =>
            appWide
                ? PAGE_INDEX.filter(entry =>
                    pageAllowed(entry, { claims, sidebar, adminSections, analyticsAllowed })
                )
                : [],
        [appWide, claims, sidebar, adminSections, analyticsAllowed]
    )

    const viewsQuery = useQuery({
        queryKey: ['globalSearch', 'views', debouncedQuery],
        queryFn: () => listViews({ search: debouncedQuery, limit: VIEW_FETCH_LIMIT }),
        enabled: debouncedQuery.length > 0,
        staleTime: 30_000,
    })

    // Building the docs index fetches every markdown chunk, so it waits
    // for a query worth answering and is then kept for the session — the
    // module cache would survive anyway, this stops a second in-flight
    // build and any refetch.
    const docsQuery = useQuery({
        queryKey: ['globalSearch', 'docsIndex'],
        queryFn: getIndex,
        enabled: appWide && debouncedQuery.length > 0,
        staleTime: Infinity,
        gcTime: Infinity,
    })

    return useMemo<GlobalSearchResult>(() => {
        const empty = emptyResult(trimmed)
        if (!debouncedQuery) return empty

        // Pages & settings ───────────────────────────────────────────────
        const pageScored = scoreCandidates(visiblePages, debouncedQuery, PAGE_FIELDS)
        const pageHits: PageHit[] = pageScored.map(({ item, score }) => ({
            id: `page-${item.id}`,
            category: item.category,
            name: item.title,
            description: item.description,
            score,
            path: item.path,
        }))
        const destinationHits = pageHits.filter(h => h.category === 'Page')
        const settingHits = pageHits.filter(h => h.category === 'Setting')

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

        // Docs & guide ───────────────────────────────────────────────────
        // Gated on `appWide` as well as on the data, because one
        // QueryClient serves the whole app: once the palette has built the
        // index it stays in the cache, and `enabled: false` withholds the
        // fetch, not the cached value. Without this the Dashboard hero
        // would start answering with documentation.
        //
        // The markdown carries `{brand}` tokens literally, in titles as
        // well as prose, so nothing reaches a reader un-interpolated.
        const docResults = appWide && docsQuery.data ? runSearch(docsQuery.data, debouncedQuery) : []
        const docHits: DocHit[] = docResults.map(r => ({
            id: `doc-${r.area}-${r.slug}`,
            category: 'Doc',
            name: interpolateBrand(r.title, brand),
            description: interpolateBrand(r.snippet.map(seg => seg.text).join(''), brand),
            score: r.score,
            area: r.area,
            slug: r.slug,
        }))

        const totalByCategory: Record<SearchCategory, number> = {
            Page: destinationHits.length,
            Workspace: workspaceHits.length,
            'Data Source': dataSourceHits.length,
            // The server's count of every match, not the size of the page
            // it sent — "Show all 137 in Explorer" has to be true.
            View: viewsQuery.data?.total ?? 0,
            Template: templateHits.length,
            'Semantic Layer': ontologyHits.length,
            Setting: settingHits.length,
            Doc: docHits.length,
        }

        const byCategory: Record<SearchCategory, SearchHit[]> = {
            Page: destinationHits.slice(0, limitPerCategory),
            Workspace: workspaceHits.slice(0, limitPerCategory),
            'Data Source': dataSourceHits.slice(0, limitPerCategory),
            View: viewHits.slice(0, limitPerCategory),
            Template: templateHits.slice(0, limitPerCategory),
            'Semantic Layer': ontologyHits.slice(0, limitPerCategory),
            Setting: settingHits.slice(0, limitPerCategory),
            Doc: docHits.slice(0, limitPerCategory),
        }

        const isStale = trimmed !== debouncedQuery
        return {
            query: debouncedQuery,
            isLoading: isStale || viewsQuery.isFetching,
            byCategory,
            totalByCategory,
            viewsHasMore: viewsQuery.data?.hasMore ?? false,
        }
    }, [debouncedQuery, trimmed, workspaces, templates, ontologies, viewsQuery.data, viewsQuery.isFetching, appWide, visiblePages, docsQuery.data, brand, limitPerCategory])
}

/** Flattens hits in canonical category order for consumers that want a single list. */
export function flattenHits(result: GlobalSearchResult): SearchHit[] {
    const out: SearchHit[] = []
    for (const cat of CATEGORY_ORDER) out.push(...result.byCategory[cat])
    return out
}

function emptyResult(query: string): GlobalSearchResult {
    const empty: Record<SearchCategory, SearchHit[]> = {
        Page: [],
        Workspace: [],
        'Data Source': [],
        View: [],
        Template: [],
        'Semantic Layer': [],
        Setting: [],
        Doc: [],
    }
    const zeros: Record<SearchCategory, number> = {
        Page: 0,
        Workspace: 0,
        'Data Source': 0,
        View: 0,
        Template: 0,
        'Semantic Layer': 0,
        Setting: 0,
        Doc: 0,
    }
    return {
        query,
        isLoading: false,
        byCategory: empty,
        totalByCategory: zeros,
        viewsHasMore: false,
    }
}
