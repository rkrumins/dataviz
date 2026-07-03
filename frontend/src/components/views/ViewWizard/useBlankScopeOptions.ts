/**
 * useBlankScopeOptions — the pickers for the wizard's "Start from blank" scope
 * step: the FalkorDB provider instances a blank model can be provisioned on, and
 * the published semantic layers it can be seeded with.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

export interface BlankScopeOptions {
  /** FalkorDB providers that are active and permitted for this workspace. */
  providers: ProviderResponse[]
  /** Published, non-deleted ontologies a blank model can be seeded from. */
  ontologies: OntologyDefinitionResponse[]
  isLoading: boolean
  isError: boolean
}

/** A provider is available to a workspace when its allow-list is empty (unrestricted),
 *  carries the wildcard, or explicitly lists the workspace. */
function providerPermitted(p: ProviderResponse, wsId: string | null): boolean {
  const perm = p.permittedWorkspaces ?? []
  return perm.length === 0 || perm.includes('*') || (!!wsId && perm.includes(wsId))
}

export function useBlankScopeOptions(wsId: string | null): BlankScopeOptions {
  const providersQuery = useQuery({
    queryKey: ['providers', 'list'],
    queryFn: () => providerService.list(),
    staleTime: 30_000,
  })
  const ontologiesQuery = useOntologies()

  const providers = useMemo(
    () =>
      (providersQuery.data ?? []).filter(
        p => p.providerType === 'falkordb' && p.isActive && providerPermitted(p, wsId),
      ),
    [providersQuery.data, wsId],
  )

  const ontologies = useMemo(
    () => (ontologiesQuery.data ?? []).filter(o => o.isPublished && !o.deletedAt),
    [ontologiesQuery.data],
  )

  return {
    providers,
    ontologies,
    isLoading: providersQuery.isLoading || ontologiesQuery.isLoading,
    isError: providersQuery.isError || ontologiesQuery.isError,
  }
}
