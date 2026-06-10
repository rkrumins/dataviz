/**
 * useAllowedChildren — ontology preflight for the guided create panel.
 *
 * Given a parent urn, returns every entity type annotated with whether it may
 * be created as a child (the backend `allowed-children` endpoint). Drives the
 * type picker: allowed types are selectable, disallowed ones are disabled with
 * a `reason`. Keyed by branch + provider so a draft and main never share a
 * result, and so a branch switch refetches.
 */
import { useQuery } from '@tanstack/react-query'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useCurrentBranchId } from '@/store/branchStore'
import type { AllowedChildOption } from '@/providers/GraphDataProvider'

export const ALLOWED_CHILDREN_QUERY_KEY = ['ontology', 'allowed-children'] as const

export function useAllowedChildren(parentUrn: string | null | undefined) {
  const { provider, workspaceId, dataSourceId, providerVersion } = useGraphProviderContext()
  const branchId = useCurrentBranchId()

  const query = useQuery<AllowedChildOption[]>({
    queryKey: [...ALLOWED_CHILDREN_QUERY_KEY, workspaceId, dataSourceId, branchId, providerVersion, parentUrn],
    queryFn: () => provider!.getAllowedChildren(parentUrn!),
    enabled: Boolean(provider && parentUrn),
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
