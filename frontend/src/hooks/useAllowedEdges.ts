/**
 * useAllowedEdges — ontology preflight for the edge-type picker.
 *
 * Given a source urn (and direction), returns every relationship type annotated
 * with whether it may originate from this node (the backend `allowed-edges`
 * endpoint). The popover narrows these to drawable raw lineage types via
 * {@link selectDrawableLineageEdges}. Keyed by branch + provider so a draft and
 * main never share a result.
 */
import { useQuery } from '@tanstack/react-query'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useCurrentBranchId } from '@/store/branchStore'
import type { AllowedEdgeOption, EdgeDirection } from '@/providers/GraphDataProvider'

export const ALLOWED_EDGES_QUERY_KEY = ['ontology', 'allowed-edges'] as const

export function useAllowedEdges(
  sourceUrn: string | null | undefined,
  direction: EdgeDirection = 'outgoing',
) {
  const { provider, workspaceId, dataSourceId, providerVersion } = useGraphProviderContext()
  const branchId = useCurrentBranchId()

  const query = useQuery<AllowedEdgeOption[]>({
    queryKey: [...ALLOWED_EDGES_QUERY_KEY, workspaceId, dataSourceId, branchId, providerVersion, sourceUrn, direction],
    queryFn: () => provider!.getAllowedEdges(sourceUrn!, direction),
    enabled: Boolean(provider && sourceUrn),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  })

  return {
    options: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  }
}
