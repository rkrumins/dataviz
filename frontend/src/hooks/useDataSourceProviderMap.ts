/**
 * useDataSourceProviderMap — resolves the Provider and the semantic layer
 * behind every data source.
 *
 * Catalog-onboarded sources resolve via `DataSource.catalogItemId →
 * CatalogItem.providerId → Provider`; manual/blank sources (no catalog item)
 * resolve directly through their own `providerId`. This hook fetches catalog
 * items + providers once, walks every workspace's data sources from the
 * workspaces store, and returns a lookup keyed by data source id.
 *
 * The catalog/provider list endpoints are admin-gated (they suppress the 403
 * modal on read), so for non-admin users the fetch fails quietly and the map is
 * simply empty — callers should treat a missing entry as "provider unknown".
 */
import { useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useAnyWorkspacePermission } from '@/store/auth'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'

const EMPTY_CATALOG: CatalogItemResponse[] = []
const EMPTY_PROVIDERS: ProviderResponse[] = []
const EMPTY_ONTOLOGIES: OntologyDefinitionResponse[] = []

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
  // The semantic layer each source is read through. A view's own
  // `contextModelName` is NOT this — that is the view's optional context model
  // and is null on most views, which is why the catalogue could never name the
  // ontology while the view's own details panel could: the id lives on the DATA
  // SOURCE. One cached list serves every card on the page.
  //
  // Admin-gated with a silent 403 (same as catalog/providers), so a
  // non-admin resolves to an empty list and callers simply omit the fact.
  // ALL VERSIONS, deliberately. A data source pins the exact ontology version
  // it reads through, and `list()` returns only the latest per schema — so a
  // source on v1 of a schema now at v2 resolved to nothing at all, and its
  // views showed no semantic layer while sources on a current version did.
  // (Measured: `Perf-Load-Test-Solidatus` pins bp_3e105c56b3b4, "Solidatus
  // roots-node" v1, while the schema's head is v2.) Taking the head instead
  // would be worse than silence — it would name a version the source is not
  // reading. 38 rows in the whole table, cached five minutes.
  const ontologiesQuery = useQuery({
    queryKey: ['ontologies', 'list', 'all-versions'],
    queryFn: () => ontologyDefinitionService.list(true),
    enabled: canRead,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const catalogItems = catalogQuery.data ?? EMPTY_CATALOG
  const providers = providersQuery.data ?? EMPTY_PROVIDERS
  const ontologies = ontologiesQuery.data ?? EMPTY_ONTOLOGIES

  const map = useMemo(() => {
    const catMap: Record<string, CatalogItemResponse> = {}
    for (const c of catalogItems) catMap[c.id] = c
    const provMap: Record<string, ProviderResponse> = {}
    for (const p of providers) provMap[p.id] = p
    const ontMap: Record<string, OntologyDefinitionResponse> = {}
    for (const o of ontologies) ontMap[o.id] = o

    const result: Record<string, DataSourceProviderInfo> = {}
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const cat = ds.catalogItemId ? catMap[ds.catalogItemId] : undefined
        // Manual/blank sources have no catalog item but always carry a
        // providerId — resolve them directly so fully-managed models get
        // provider identity too (they'd otherwise be skipped entirely).
        const providerId = cat?.providerId ?? ds.providerId
        if (!providerId) continue
        const prov = provMap[providerId]
        const ont = ds.ontologyId ? ontMap[ds.ontologyId] : undefined
        result[ds.id] = {
          providerId,
          providerName: prov?.name || providerId,
          providerType: prov?.providerType || 'unknown',
          sourceIdentifier: cat?.sourceIdentifier ?? ds.graphName,
          catalogItemName: cat?.name ?? ds.label,
          host: prov?.host,
          port: prov?.port,
          // Only ever the resolved NAME. An unresolved id must stay absent
          // rather than surface as a raw identifier the reader cannot use.
          ontologyName: ont?.name,
          ontologyVersion: ont?.version,
        }
      }
    }
    return result
  }, [workspaces, catalogItems, providers, ontologies])

  const resolve = useCallback(
    (dataSourceId?: string | null): DataSourceProviderInfo | undefined =>
      dataSourceId ? map[dataSourceId] : undefined,
    [map],
  )

  return { map, resolve }
}
