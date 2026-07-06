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
import { useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useAnyWorkspacePermission } from '@/store/auth'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'

const EMPTY_CATALOG: CatalogItemResponse[] = []
const EMPTY_PROVIDERS: ProviderResponse[] = []

export function useDataSourceProviderMap() {
  const workspaces = useWorkspacesStore(s => s.workspaces)

  // Mirror the backend gates (catalog.py / providers.py both `requires(...,
  // workspace_any=True)`) so users without access don't fire two
  // guaranteed-403 round trips on every mount. Hooks are called
  // unconditionally (hook rules); the fetch is what's gated.
  const canReadCatalog = useAnyWorkspacePermission('workspace:catalog:read')
  const canReadProviders = useAnyWorkspacePermission('workspace:provider:read')
  const canRead = canReadCatalog && canReadProviders

  // Shared React Query caches — same keys/queryFns as useBlankScopeOptions,
  // so every consumer of either hook reads one cached list instead of
  // firing its own pair of requests per mount. A failed fetch leaves
  // `data` undefined → empty map → callers gracefully omit the provider
  // detail, matching the old catch-and-ignore behavior.
  const catalogQuery = useQuery({
    queryKey: ['catalog', 'list'],
    queryFn: () => catalogService.list(),
    enabled: canRead,
    staleTime: 5 * 60_000,
  })
  const providersQuery = useQuery({
    queryKey: ['providers', 'list'],
    queryFn: () => providerService.list(),
    enabled: canRead,
    staleTime: 5 * 60_000,
  })
  const catalogItems = catalogQuery.data ?? EMPTY_CATALOG
  const providers = providersQuery.data ?? EMPTY_PROVIDERS

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
