import { useQuery } from '@tanstack/react-query'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse, type ProviderImpactResponse } from '@/services/providerService'
import { useAssetStats } from '@/hooks/useAssetStats'
import type { AssetStatsPayload, InsightsMeta } from '@/types/insights'

export interface DataSourceProfileData {
  item: CatalogItemResponse | undefined
  provider: ProviderResponse | undefined
  stats: AssetStatsPayload | undefined
  meta: InsightsMeta | undefined
  consumers: ProviderImpactResponse | undefined
  isLoading: boolean
  notFound: boolean
}

export function useDataSourceProfile(catalogId: string | null): DataSourceProfileData {
  const itemQuery = useQuery({
    queryKey: ['catalog-item', catalogId],
    queryFn: () => catalogService.get(catalogId!),
    enabled: !!catalogId,
    staleTime: 30_000,
  })
  const item = itemQuery.data

  const providerQuery = useQuery({
    queryKey: ['provider', item?.providerId],
    queryFn: () => providerService.get(item!.providerId),
    enabled: !!item?.providerId,
    staleTime: 60_000,
  })

  const impactQuery = useQuery({
    queryKey: ['catalog-impact', catalogId],
    queryFn: () => catalogService.getImpact(catalogId!),
    enabled: !!catalogId,
    staleTime: 30_000,
  })

  const statsQuery = useAssetStats(item?.providerId ?? '', item?.sourceIdentifier ?? '', {
    enabled: !!item?.providerId && !!item?.sourceIdentifier,
  })

  return {
    item,
    provider: providerQuery.data,
    stats: statsQuery.data?.data ?? undefined,
    meta: statsQuery.data?.meta,
    consumers: impactQuery.data,
    isLoading: itemQuery.isLoading,
    notFound: itemQuery.isError,
  }
}
