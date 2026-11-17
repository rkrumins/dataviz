import { useQuery } from '@tanstack/react-query'
import { getImportSettings } from '@/services/importExportApiService'

const key = (wsId?: string, graphId?: string | null) => ['importSettings', wsId, graphId] as const

/** What a graph's imports run under: its own settings over the platform's. */
export function useImportSettings(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: key(wsId, graphId),
    queryFn: () => getImportSettings(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    staleTime: 60_000,
  })
}
