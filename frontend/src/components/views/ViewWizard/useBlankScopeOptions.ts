/**
 * useBlankScopeOptions — the pickers for the wizard's "Start from blank" scope
 * step: the graph providers a blank model can be provisioned on (with per-provider
 * graph counts and in-use counts), and the published semantic layers it can be
 * seeded with.
 *
 * All provider types are surfaced so the picker is a complete, honest catalog,
 * but only providers whose catalog entry supports `blank_models` can actually
 * back one today (the backend 422s the rest) — that gate travels on each
 * option as `blankSupported`.
 */
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import { useWorkspacesStore } from '@/store/workspaces'
import { useProviderStatusStore } from '@/store/providerStatus'
import { useProviderTypes } from '@/hooks/useProviderTypes'
import { supportsFeature } from '@/services/providerTypes'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

/** A provider surfaced in the blank picker, enriched with catalog + usage counts. */
export interface ProviderScopeOption {
  provider: ProviderResponse
  /** Catalog items (graphs) registered on this provider. */
  graphCount: number
  /** Data sources across the loaded workspaces that are built on this provider. */
  inUseCount: number
  /** Whether this provider's catalog entry supports blank models. */
  blankSupported: boolean
}

export interface BlankScopeOptions {
  /** Providers permitted for this workspace, all types, supported-first. */
  providers: ProviderScopeOption[]
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
  // Catalog items map a physical graph on a provider; counting them per provider
  // gives the "N graphs" figure. Silent-403 on read, so non-admins simply see 0.
  const catalogQuery = useQuery({
    queryKey: ['catalog', 'list'],
    queryFn: () => catalogService.list(),
    staleTime: 30_000,
  })
  const ontologiesQuery = useOntologies()
  const { types: providerTypes } = useProviderTypes()

  // Freshen provider health the moment the picker opens, so a provider that went
  // down since the last background poll shows offline immediately rather than up to
  // a poll-interval later. The global poll (every ~30s) keeps it current afterward.
  useEffect(() => {
    void useProviderStatusStore.getState().refresh()
  }, [])

  // The wizard already loads the workspaces list; reuse it to count how many
  // existing data sources are built on each provider ("M in use").
  const workspaces = useWorkspacesStore(s => s.workspaces)

  const providers = useMemo<ProviderScopeOption[]>(() => {
    const permitted = (providersQuery.data ?? []).filter(p => providerPermitted(p, wsId))
    const catalogItems = catalogQuery.data ?? []

    const graphByProvider: Record<string, number> = {}
    const catalogToProvider: Record<string, string> = {}
    for (const item of catalogItems) {
      graphByProvider[item.providerId] = (graphByProvider[item.providerId] ?? 0) + 1
      catalogToProvider[item.id] = item.providerId
    }

    const inUseByProvider: Record<string, number> = {}
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const providerId = ds.catalogItemId ? catalogToProvider[ds.catalogItemId] : undefined
        if (providerId) inUseByProvider[providerId] = (inUseByProvider[providerId] ?? 0) + 1
      }
    }

    return permitted
      .map(provider => ({
        provider,
        graphCount: graphByProvider[provider.id] ?? 0,
        inUseCount: inUseByProvider[provider.id] ?? 0,
        blankSupported: supportsFeature(provider.providerType, 'blank_models', providerTypes),
      }))
      .sort((a, b) => {
        // Supported (selectable) providers first, then alphabetically by name.
        if (a.blankSupported !== b.blankSupported) return a.blankSupported ? -1 : 1
        return a.provider.name.localeCompare(b.provider.name)
      })
  }, [providersQuery.data, catalogQuery.data, workspaces, wsId, providerTypes])

  const ontologies = useMemo(
    () => (ontologiesQuery.data ?? []).filter(o => o.isPublished && !o.deletedAt),
    [ontologiesQuery.data],
  )

  return {
    providers,
    ontologies,
    // Catalog is a nice-to-have (counts only) — don't block the picker on it.
    isLoading: providersQuery.isLoading || ontologiesQuery.isLoading,
    isError: providersQuery.isError || ontologiesQuery.isError,
  }
}
