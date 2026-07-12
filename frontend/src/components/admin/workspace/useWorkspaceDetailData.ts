import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { listViews, type View } from '@/services/viewApiService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { deriveWorkspaceHealth } from './WorkspaceHealthBadge'
import { withTimeout, mapWithConcurrency } from '@/lib/concurrency'
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
}

export interface UseWorkspaceDetailDataReturn {
  workspace: WorkspaceResponse | null
  catalogItems: CatalogItemResponse[]
  ontologies: OntologyDefinitionResponse[]
  ontologyMap: Record<string, OntologyDefinitionResponse>
  dsStatsMap: Record<string, DataSourceStats>
  dsProviderMap: Record<string, DataSourceProviderInfo>
  viewsByDs: Record<string, View[]>
  allWorkspaceViews: View[]
  readinessMap: Record<string, DataSourceReadinessResponse>
  healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown'
  aggregateStats: { totalNodes: number; totalEdges: number; totalTypes: number; totalViews: number }
  /** True only before the first successful fetch (or while navigating to a different wsId). */
  isLoading: boolean
  /** True while a background refresh is in flight after the page has already rendered. */
  isRefreshing: boolean
  error: string | null
  reload: () => void
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
  // `workspace.id !== wsId` skeleton behavior).
  const workspaceQuery = useQuery({
    queryKey: ['workspace', wsId],
    enabled: !!wsId,
    queryFn: () => withTimeout(workspaceService.get(wsId!), TIMEOUTS.ADMIN_LIST_MS, 'workspace.get'),
  })

  const workspace = workspaceQuery.data ?? null
  const catalogItems = catalogQuery.data ?? EMPTY_CATALOG
  const ontologies = ontologyDefsQuery.data ?? EMPTY_ONTOLOGY_DEFS
  const providers = providersQuery.data ?? EMPTY_PROVIDERS

  // Phase 2 — per-DS stats + readiness + this workspace's views. Depends on the
  // workspace (its data-source set) and is keyed on the sorted DS ids, so it
  // only re-runs when that set changes. One cached unit: the bulk-stats read,
  // the concurrency-capped readiness fan-out (bulkhead), and the views list.
  const dsIdSetKey = useMemo(
    () => (workspace?.dataSources || []).map(d => d.id).sort().join(','),
    [workspace],
  )
  const phase2Query = useQuery({
    queryKey: ['workspace-detail-phase2', wsId, dsIdSetKey],
    enabled: !!workspace,
    queryFn: async () => {
      const ws = workspace!
      const stats: Record<string, DataSourceStats> = {}
      const readiness: Record<string, DataSourceReadinessResponse> = {}
      let views: View[] = []

      await Promise.all([
        // One bulk request (scoped to this workspace) replaces the former
        // per-datasource cached-stats fan-out. Entries keyed "<wsId>/<dsId>";
        // status==='computing' rows are cold-cache placeholders (refresh
        // already enqueued server-side).
        fetchEnveloped<Record<string, {
          status?: string
          nodeCount?: number
          edgeCount?: number
          entityTypeCounts?: Record<string, number>
        }>>(
          `/api/v1/admin/workspaces/datasources/cached-stats?workspace_id=${encodeURIComponent(ws.id)}`,
        ).then(bulk => {
          for (const [key, entry] of Object.entries(bulk ?? {})) {
            const dsId = key.slice(key.indexOf('/') + 1)
            if (entry.status === 'computing') {
              // Record the cold-cache placeholder (instead of skipping) so the
              // card shows a "computing" state rather than a blank dash.
              stats[dsId] = { nodeCount: 0, edgeCount: 0, entityTypes: [], computing: true }
              continue
            }
            stats[dsId] = {
              nodeCount: entry.nodeCount ?? 0,
              edgeCount: entry.edgeCount ?? 0,
              entityTypes: Object.keys(entry.entityTypeCounts ?? {}),
            }
          }
        }).catch(() => {}),
        // WS0.4 bulkhead: cap the per-source readiness fan-out. A workspace
        // with many sources must not fire one unbounded request per source —
        // when a provider is down each hangs to the fetch timeout and the batch
        // saturates the browser's ~6 HTTP/1.1 connections (the app-wide "storm").
        mapWithConcurrency(ws.dataSources || [], 4, async (ds) => {
          const ready = await aggregationService.getReadiness(ds.id).catch(() => null)
          if (ready) readiness[ds.id] = ready
        }),
        listViews({ workspaceId: ws.id }).then(v => { views = v.items }).catch(() => {}),
      ])

      return { stats, readiness, views }
    },
  })

  const dsStatsMap = phase2Query.data?.stats ?? EMPTY_STATS
  const readinessMap = phase2Query.data?.readiness ?? EMPTY_READINESS
  const allWorkspaceViews = phase2Query.data?.views ?? EMPTY_VIEWS

  // Loading = no workspace loaded for THIS wsId yet (the query is keyed by wsId,
  // so its data is always for the current wsId; the second clause preserves the
  // old exact condition). isRefreshing = a background refetch is in flight after
  // the page already rendered — callers show a subtle indicator, not a spinner.
  const isLoading = !workspace || workspace.id !== wsId
  const isRefreshing = workspaceQuery.isFetching || phase2Query.isFetching
  // Matches the old behavior: only a workspace.get failure surfaced an error;
  // the list + phase-2 failures were swallowed (empty fallbacks).
  const error = workspaceQuery.error instanceof Error ? workspaceQuery.error.message : null

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['workspace', wsId] })
    queryClient.invalidateQueries({ queryKey: ['workspace-detail-phase2', wsId] })
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

  // Derived: viewsByDs
  const viewsByDs = useMemo(() => {
    const map: Record<string, View[]> = {}
    for (const v of allWorkspaceViews) {
      const key = v.dataSourceId || '_unscoped'
      ;(map[key] ??= []).push(v)
    }
    return map
  }, [allWorkspaceViews])

  // Derived: healthStatus
  const healthStatus = useMemo(() => {
    if (!workspace) return 'unknown' as const
    const entries = Object.values(readinessMap)
    if (entries.length === 0) return 'unknown' as const
    return deriveWorkspaceHealth(entries.map(r => ({ aggregationStatus: r.aggregationStatus })))
  }, [workspace, readinessMap])

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
    return { totalNodes, totalEdges, totalTypes: allTypes.size, totalViews: allWorkspaceViews.length }
  }, [dsStatsMap, allWorkspaceViews])

  return {
    workspace,
    catalogItems,
    ontologies,
    ontologyMap,
    dsStatsMap,
    dsProviderMap,
    viewsByDs,
    allWorkspaceViews,
    readinessMap,
    healthStatus,
    aggregateStats,
    isLoading,
    isRefreshing,
    error,
    reload,
  }
}

/**
 * Warm the workspace-detail cache (e.g. on card hover) so opening the detail
 * page is instant. Matches the gating ``['workspace', wsId]`` query above
 * EXACTLY (key + fetch), so a subsequent visit within staleTime is a cache hit
 * that renders the workspace immediately (and kicks off the phase-2 fan-out).
 */
export function prefetchWorkspaceDetail(queryClient: QueryClient, wsId: string) {
  queryClient.prefetchQuery({
    queryKey: ['workspace', wsId],
    queryFn: () => withTimeout(workspaceService.get(wsId), TIMEOUTS.ADMIN_LIST_MS, 'workspace.get'),
    staleTime: 5 * 60 * 1000,
  })
}
