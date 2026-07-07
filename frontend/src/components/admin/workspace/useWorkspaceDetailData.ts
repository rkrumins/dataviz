import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { listViews, type View } from '@/services/viewApiService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { deriveWorkspaceHealth } from './WorkspaceHealthBadge'
import { withTimeout } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'

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
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [catalogItems, setCatalogItems] = useState<CatalogItemResponse[]>([])
  const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])
  const [providers, setProviders] = useState<ProviderResponse[]>([])
  const [dsStatsMap, setDsStatsMap] = useState<Record<string, DataSourceStats>>({})
  const [allWorkspaceViews, setAllWorkspaceViews] = useState<View[]>([])
  const [readinessMap, setReadinessMap] = useState<Record<string, DataSourceReadinessResponse>>({})
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived: the page is "loading" (full-screen spinner) only when no workspace
  // has been loaded yet for this wsId. Subsequent reloads keep the rendered
  // page mounted and flip `isRefreshing` instead — callers should render a
  // subtle indicator rather than unmounting the tree.
  const isLoading = !workspace || workspace.id !== wsId

  const loadWorkspace = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!wsId) return
    setIsRefreshing(true)
    setError(null)
    try {
      // Phase 1 — parallel initial fetch. Each call gets a hard timeout
      // so a single slow backend (e.g. provider listing held up by an
      // unhealthy provider) doesn't pin the whole page on a spinner.
      // Workspace itself is the only mandatory result; the rest fall
      // back to empty lists and the page renders in a degraded state.
      const settled = await Promise.allSettled([
        withTimeout(workspaceService.get(wsId), TIMEOUTS.ADMIN_LIST_MS, 'workspace.get'),
        withTimeout(catalogService.list(), TIMEOUTS.ADMIN_LIST_MS, 'catalog.list'),
        withTimeout(ontologyDefinitionService.list(), TIMEOUTS.ADMIN_LIST_MS, 'ontology.list'),
        withTimeout(providerService.list(), TIMEOUTS.ADMIN_LIST_MS, 'providers.list'),
      ])
      if (signal?.cancelled) return

      const wsRes = settled[0]
      if (wsRes.status !== 'fulfilled') {
        throw wsRes.reason instanceof Error ? wsRes.reason : new Error(String(wsRes.reason))
      }
      const ws = wsRes.value
      const catalogList = settled[1].status === 'fulfilled' ? settled[1].value : ([] as CatalogItemResponse[])
      const ontologyList = settled[2].status === 'fulfilled' ? settled[2].value : ([] as OntologyDefinitionResponse[])
      const providerList = settled[3].status === 'fulfilled' ? settled[3].value : ([] as ProviderResponse[])

      setWorkspace(ws)
      setCatalogItems(catalogList)
      setOntologies(ontologyList)
      setProviders(providerList)

      // Phase 2 — per-DS stats + readiness, plus workspace views
      const stats: Record<string, DataSourceStats> = {}
      const readiness: Record<string, DataSourceReadinessResponse> = {}
      let views: View[] = []

      await Promise.all([
        // One bulk request (scoped to this workspace) replaces the former
        // per-datasource cached-stats fan-out. Entries are keyed
        // "<wsId>/<dsId>"; status==='computing' rows are cold-cache
        // placeholders (refresh already enqueued server-side) — skip them,
        // matching the old null-on-computing behavior.
        fetchEnveloped<Record<string, {
          status?: string
          nodeCount?: number
          edgeCount?: number
          entityTypeCounts?: Record<string, number>
        }>>(
          `/api/v1/admin/workspaces/datasources/cached-stats?workspace_id=${encodeURIComponent(ws.id)}`,
        ).then(bulk => {
          for (const [key, entry] of Object.entries(bulk ?? {})) {
            if (entry.status === 'computing') continue
            const dsId = key.slice(key.indexOf('/') + 1)
            stats[dsId] = {
              nodeCount: entry.nodeCount ?? 0,
              edgeCount: entry.edgeCount ?? 0,
              entityTypes: Object.keys(entry.entityTypeCounts ?? {}),
            }
          }
        }).catch(() => {}),
        ...((ws.dataSources || []).map(async (ds) => {
          const ready = await aggregationService.getReadiness(ds.id).catch(() => null)
          if (ready) readiness[ds.id] = ready
        })),
        listViews({ workspaceId: wsId }).then(v => { views = v.items }).catch(() => {}),
      ])
      if (signal?.cancelled) return

      setDsStatsMap(stats)
      setReadinessMap(readiness)
      setAllWorkspaceViews(views)
    } catch (err) {
      if (signal?.cancelled) return
      console.error('Failed to load workspace', err)
      setError(err instanceof Error ? err.message : 'Failed to load workspace')
    } finally {
      if (!signal?.cancelled) setIsRefreshing(false)
    }
  }, [wsId])

  useEffect(() => {
    const signal = { cancelled: false }
    loadWorkspace(signal)
    return () => { signal.cancelled = true }
  }, [loadWorkspace])

  const reload = useCallback(() => { loadWorkspace() }, [loadWorkspace])

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
