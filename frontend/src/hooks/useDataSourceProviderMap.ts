/**
 * useDataSourceProviderMap — resolves the Provider behind every data source.
 *
 * A view/data source only carries a `catalogItemId`; the provider it is built
 * from is reached via `DataSource.catalogItemId → CatalogItem.providerId →
 * Provider`. This hook fetches catalog items + providers once, walks every
 * workspace's data sources from the workspaces store, and returns a lookup
 * keyed by data source id.
 *
 * The catalog/provider list endpoints are admin-gated (they suppress the 403
 * modal on read), so for non-admin users the fetch fails quietly and the map is
 * simply empty — callers should treat a missing entry as "provider unknown".
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { useWorkspacesStore } from '@/store/workspaces'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'

export function useDataSourceProviderMap() {
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const [catalogItems, setCatalogItems] = useState<CatalogItemResponse[]>([])
  const [providers, setProviders] = useState<ProviderResponse[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([catalogService.list(), providerService.list()])
      .then(([cats, provs]) => {
        if (cancelled) return
        setCatalogItems(cats)
        setProviders(provs)
      })
      .catch(() => {
        // Non-admin (403) or transient failure — leave the map empty so callers
        // gracefully omit the provider detail rather than erroring.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const map = useMemo(() => {
    const catMap: Record<string, CatalogItemResponse> = {}
    for (const c of catalogItems) catMap[c.id] = c
    const provMap: Record<string, ProviderResponse> = {}
    for (const p of providers) provMap[p.id] = p

    const result: Record<string, DataSourceProviderInfo> = {}
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const cat = catMap[ds.catalogItemId]
        if (!cat) continue
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
  }, [workspaces, catalogItems, providers])

  const resolve = useCallback(
    (dataSourceId?: string | null): DataSourceProviderInfo | undefined =>
      dataSourceId ? map[dataSourceId] : undefined,
    [map],
  )

  return { map, resolve }
}
