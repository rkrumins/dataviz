import { useCallback, useMemo } from 'react'
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { getViewCounts, listViews, type View } from '@/services/viewApiService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { useWorkspacesStore } from '@/store/workspaces'
import { deriveWorkspaceHealth, type WorkspaceHealth } from './WorkspaceHealthBadge'
import { withTimeout } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'

// Stable empty refs so a missing/loading query doesn't hand the derived
// useMemos a fresh array/object identity on every render.
const EMPTY_CATALOG: CatalogItemResponse[] = []
const EMPTY_ONTOLOGY_DEFS: OntologyDefinitionResponse[] = []
const EMPTY_PROVIDERS: ProviderResponse[] = []
const EMPTY_VIEWS: View[] = []
const EMPTY_STATS: Record<string, DataSourceStats> = {}
const EMPTY_READINESS: Record<string, DataSourceReadinessResponse> = {}

/** Resolved provider info for a data source (derived from catalogItem → provider). */
export interface DataSourceProviderInfo {
  providerId: string
  providerName: string
  providerType: string   // 'falkordb' | 'neo4j' | 'datahub' | 'mock'
  sourceIdentifier?: string
  catalogItemName?: string
  host?: string
  port?: number
  /** The semantic layer this source is read through, resolved from
   *  `dataSource.ontologyId`. Absent when the source declares none, or when
   *  the caller cannot read the ontologies list (it is admin-gated and fails
   *  silently) — treat missing as "unknown", never as "none". */
  ontologyName?: string
  ontologyVersion?: number
}

export interface UseWorkspaceDetailDataReturn {
  workspace: WorkspaceResponse | null
  catalogItems: CatalogItemResponse[]
  providers: ProviderResponse[]
  ontologies: OntologyDefinitionResponse[]
  ontologyMap: Record<string, OntologyDefinitionResponse>
  dsStatsMap: Record<string, DataSourceStats>
  dsProviderMap: Record<string, DataSourceProviderInfo>
  /** The workspace's most recently changed views — the list's first page, not
   *  every view. For how many there are, read `viewTotal` / `viewCountByDs`. */
  allWorkspaceViews: View[]
  /** How many views the reader can open here, exactly; null until known. */
  viewTotal: number | null
  /** The same per data source (a source with none is absent); null until known. */
  viewCountByDs: Record<string, number> | null
  readinessMap: Record<string, DataSourceReadinessResponse>
  healthStatus: WorkspaceHealth
  /** `totalViews` is `viewTotal`: null until known. */
  aggregateStats: { totalNodes: number; totalEdges: number; totalTypes: number; totalViews: number | null }
  /** Each section's first load still in flight — each renders its own skeleton
   *  meanwhile, and none waits for another. */
  pending: { stats: boolean; readiness: boolean; views: boolean; viewCounts: boolean }
  /** True only before the first successful fetch (or while navigating to a different wsId). */
  isLoading: boolean
  /** True while a background refresh is in flight after the page has already rendered. */
  isRefreshing: boolean
  error: string | null
  reload: () => void
}

/** One source's entry in the bulk cached-stats read. */
interface CachedStatsEntry {
  status?: string
  nodeCount?: number
  edgeCount?: number
  entityTypeCounts?: Record<string, number>
}

/**
 * The page's reads. Each is keyed by the workspace id alone, so every one starts
 * the moment the id is known — none waits for the workspace record or for
 * another, and each section renders when its own answer lands. The detail reads
 * share the `['workspace-detail', wsId]` prefix, so one invalidation refreshes
 * them all; the view counts sit with the other view numbers under
 * `['views', 'counts']`, which view changes already refresh.
 */
const detailQueries = {
  workspace: (wsId: string) => queryOptions({
    queryKey: ['workspace', wsId],
    queryFn: () => withTimeout(workspaceService.get(wsId), TIMEOUTS.ADMIN_LIST_MS, 'workspace.get'),
  }),
  // One bulk request (scoped to this workspace) for every source's counts.
  // Entries keyed "<wsId>/<dsId>"; status==='computing' rows are cold-cache
  // placeholders (refresh already enqueued server-side), recorded rather than
  // skipped so the card shows a "computing" state instead of a blank dash.
  stats: (wsId: string) => queryOptions({
    queryKey: ['workspace-detail', wsId, 'stats'],
    queryFn: async () => {
      const bulk = await fetchEnveloped<Record<string, CachedStatsEntry>>(
        `/api/v1/admin/workspaces/datasources/cached-stats?workspace_id=${encodeURIComponent(wsId)}`,
      )
      const stats: Record<string, DataSourceStats> = {}
      for (const [key, entry] of Object.entries(bulk ?? {})) {
        const dsId = key.slice(key.indexOf('/') + 1)
        stats[dsId] = entry.status === 'computing'
          ? { nodeCount: 0, edgeCount: 0, entityTypes: [], computing: true }
          : {
              nodeCount: entry.nodeCount ?? 0,
              edgeCount: entry.edgeCount ?? 0,
              entityTypes: Object.keys(entry.entityTypeCounts ?? {}),
            }
      }
      return stats
    },
  }),
  // Every source's readiness in one request: the server bounds its own fan-out,
  // and a source it can't read answers null (left out here) without failing the rest.
  readiness: (wsId: string) => queryOptions({
    queryKey: ['workspace-detail', wsId, 'readiness'],
    queryFn: async () => {
      const all = await aggregationService.getWorkspaceReadiness(wsId)
      const readiness: Record<string, DataSourceReadinessResponse> = {}
      for (const [dsId, r] of Object.entries(all)) if (r) readiness[dsId] = r
      return readiness
    },
  }),
  views: (wsId: string) => queryOptions({
    queryKey: ['workspace-detail', wsId, 'views'],
    queryFn: async () => (await listViews({ workspaceId: wsId })).items,
  }),
  viewCounts: (wsId: string) => queryOptions({
    queryKey: ['views', 'counts', { workspaceIds: [wsId] }],
    queryFn: () => getViewCounts({ workspaceIds: [wsId] }),
  }),
}

/**
 * The workspace as a list the app already holds it — the workspaces store, or a
 * page of the Workspaces page — so the header and its sources paint at once
 * while the record itself is fetched. The store's list carries the exact view
 * count too.
 */
function heldWorkspace(
  queryClient: QueryClient, stored: WorkspaceResponse[], wsId: string,
): WorkspaceResponse | undefined {
  const hit = stored.find(w => w.id === wsId)
  if (hit) return hit
  for (const [, page] of queryClient.getQueriesData<{ items: WorkspaceResponse[] }>({ queryKey: ['workspaces', 'page'] })) {
    const hit = page?.items.find(w => w.id === wsId)
    if (hit) return hit
  }
  return undefined
}

export function useWorkspaceDetailData(wsId: string | undefined): UseWorkspaceDetailDataReturn {
  const queryClient = useQueryClient()

  // Shared, workspace-INDEPENDENT lists. Same RQ keys other hooks already use
  // (e.g. useBlankScopeOptions), so a catalog/provider/ontology list is fetched
  // once across the app and every workspace visit reuses it — replacing the old
  // per-visit re-fetch of all three inside a single loadWorkspace() call.
  const catalogQuery = useQuery({
    queryKey: ['catalog', 'list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => withTimeout(catalogService.list(), TIMEOUTS.ADMIN_LIST_MS, 'catalog.list'),
  })
  const ontologyDefsQuery = useQuery({
    queryKey: ['ontology-defs', 'list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => withTimeout(ontologyDefinitionService.list(), TIMEOUTS.ADMIN_LIST_MS, 'ontology.list'),
  })
  const providersQuery = useQuery({
    queryKey: ['providers', 'list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => withTimeout(providerService.list(), TIMEOUTS.ADMIN_LIST_MS, 'providers.list'),
  })

  // The workspace itself — keyed by wsId so switching workspaces (and coming
  // back) is cache-served. Deliberately NOT keep-previous: a new wsId should
  // show the loading state until it resolves (matches the old
  // `workspace.id !== wsId` skeleton behavior) — unless a list the app holds
  // already has it, which paints the header and its sources at once.
  const storedWorkspaces = useWorkspacesStore(s => s.workspaces)
  const held = useMemo(
    () => (wsId ? heldWorkspace(queryClient, storedWorkspaces, wsId) : undefined),
    [queryClient, storedWorkspaces, wsId],
  )
  const workspaceQuery = useQuery({
    ...detailQueries.workspace(wsId ?? ''),
    enabled: !!wsId,
    placeholderData: held,
  })
  const statsQuery = useQuery({ ...detailQueries.stats(wsId ?? ''), enabled: !!wsId })
  const readinessQuery = useQuery({ ...detailQueries.readiness(wsId ?? ''), enabled: !!wsId })
  const viewsQuery = useQuery({ ...detailQueries.views(wsId ?? ''), enabled: !!wsId })
  const viewCountsQuery = useQuery({ ...detailQueries.viewCounts(wsId ?? ''), enabled: !!wsId })

  const workspace = workspaceQuery.data ?? null
  const catalogItems = catalogQuery.data ?? EMPTY_CATALOG
  const ontologies = ontologyDefsQuery.data ?? EMPTY_ONTOLOGY_DEFS
  const providers = providersQuery.data ?? EMPTY_PROVIDERS

  const dsStatsMap = statsQuery.data ?? EMPTY_STATS
  const readinessMap = readinessQuery.data ?? EMPTY_READINESS
  const allWorkspaceViews = viewsQuery.data ?? EMPTY_VIEWS
  // Exact, from the server: counting the first page stopped at 50. Until the
  // counts land, the held workspace list's own count (exact too) stands in —
  // the record itself carries none.
  const viewTotal = viewCountsQuery.data?.total ?? held?.viewCount ?? null
  const viewCountByDs = viewCountsQuery.data?.byDataSource ?? null

  // Loading = no workspace loaded for THIS wsId yet (the query is keyed by wsId,
  // so its data is always for the current wsId; the second clause preserves the
  // old exact condition). A load that failed is not loading: the page then says
  // it can't open the workspace instead of showing the skeleton for good.
  // isRefreshing = a background refetch is in flight after the page already
  // rendered — callers show a subtle indicator, not a spinner.
  const isLoading = !workspaceQuery.isError && (!workspace || workspace.id !== wsId)
  // A first load is each section's skeleton, not a refresh.
  const isRefreshing = [workspaceQuery, statsQuery, readinessQuery, viewsQuery, viewCountsQuery]
    .some(q => q.isFetching && !q.isPending && !q.isPlaceholderData)
  const pending = {
    stats: statsQuery.isPending,
    readiness: readinessQuery.isPending,
    views: viewsQuery.isPending,
    viewCounts: viewCountsQuery.isPending,
  }
  // Matches the old behavior: only a workspace.get failure surfaced an error;
  // a section's failure leaves it empty.
  const error = workspaceQuery.error instanceof Error ? workspaceQuery.error.message : null

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['workspace', wsId] })
    queryClient.invalidateQueries({ queryKey: ['workspace-detail', wsId] })
    queryClient.invalidateQueries({ queryKey: ['views', 'counts'] })
    queryClient.invalidateQueries({ queryKey: ['catalog', 'list'] })
    queryClient.invalidateQueries({ queryKey: ['ontology-defs', 'list'] })
    queryClient.invalidateQueries({ queryKey: ['providers', 'list'] })
  }, [queryClient, wsId])

  // Derived: ontologyMap
  const ontologyMap = useMemo(() => {
    const map: Record<string, OntologyDefinitionResponse> = {}
    for (const o of ontologies) map[o.id] = o
    return map
  }, [ontologies])

  // Derived: dsProviderMap — resolve DS → catalog item → provider
  const dsProviderMap = useMemo(() => {
    const catMap: Record<string, CatalogItemResponse> = {}
    for (const c of catalogItems) catMap[c.id] = c
    const provMap: Record<string, ProviderResponse> = {}
    for (const p of providers) provMap[p.id] = p
    const result: Record<string, DataSourceProviderInfo> = {}
    for (const ds of workspace?.dataSources || []) {
      const cat = catMap[ds.catalogItemId]
      if (cat) {
        const prov = provMap[cat.providerId]
        result[ds.id] = {
          providerId: cat.providerId,
          providerName: prov?.name || cat.providerId,
          providerType: prov?.providerType || 'unknown',
          sourceIdentifier: cat.sourceIdentifier,
          catalogItemName: cat.name,
        }
      }
    }
    return result
  }, [workspace, catalogItems, providers])

  // Derived: healthStatus
  //
  // Health asks "can I use this workspace", so it needs the node count — a
  // workspace with data is Ready even when its rollups have never run. Passing
  // nothing here would report every workspace as "Checking…" forever.
  const healthStatus = useMemo(() => {
    if (!workspace) return 'unknown' as const
    // No sources has no readiness to wait for: it is "empty", not "checking".
    if ((workspace.dataSources ?? []).length === 0) return 'empty' as const
    const entries = Object.values(readinessMap)
    if (entries.length === 0) return 'unknown' as const

    const statsLoaded = Object.keys(dsStatsMap).length > 0
    const nodeCount = statsLoaded
      ? Object.values(dsStatsMap).reduce((n, s) => n + s.nodeCount, 0)
      : undefined

    return deriveWorkspaceHealth(
      // ``projectorCurrent`` rides along because a wedged versioned source
      // reports ``aggregationStatus: 'ready'`` while serving no rolled-up
      // connections — status alone cannot see it.
      entries.map(r => ({
        aggregationStatus: r.aggregationStatus,
        projectorCurrent: r.projectorCurrent,
      })),
      { nodeCount },
    )
  }, [workspace, readinessMap, dsStatsMap])

  // Derived: aggregateStats
  const aggregateStats = useMemo(() => {
    const allTypes = new Set<string>()
    let totalNodes = 0
    let totalEdges = 0
    for (const s of Object.values(dsStatsMap)) {
      totalNodes += s.nodeCount
      totalEdges += s.edgeCount
      for (const t of s.entityTypes) allTypes.add(t)
    }
    return { totalNodes, totalEdges, totalTypes: allTypes.size, totalViews: viewTotal }
  }, [dsStatsMap, viewTotal])

  return {
    workspace,
    catalogItems,
    // The Add Data Source wizard needs the provider list to show WHICH provider each
    // catalog item comes from — the old <select> couldn't, so every option looked
    // identical. The query already ran; it just wasn't handed back.
    providers,
    ontologies,
    ontologyMap,
    dsStatsMap,
    dsProviderMap,
    allWorkspaceViews,
    viewTotal,
    viewCountByDs,
    readinessMap,
    healthStatus,
    aggregateStats,
    pending,
    isLoading,
    isRefreshing,
    error,
    reload,
  }
}

/**
 * Warm the workspace-detail cache (e.g. on card hover) so opening the detail
 * page is instant. The very queries the page runs (same keys and fetches), so a
 * visit within staleTime finds the workspace, its counts, its sources' stats and
 * readiness, and its views already there — every section renders at once.
 */
export function prefetchWorkspaceDetail(queryClient: QueryClient, wsId: string) {
  const staleTime = 5 * 60 * 1000
  void queryClient.prefetchQuery({ ...detailQueries.workspace(wsId), staleTime })
  void queryClient.prefetchQuery({ ...detailQueries.stats(wsId), staleTime })
  void queryClient.prefetchQuery({ ...detailQueries.readiness(wsId), staleTime })
  void queryClient.prefetchQuery({ ...detailQueries.views(wsId), staleTime })
  void queryClient.prefetchQuery({ ...detailQueries.viewCounts(wsId), staleTime })
}
