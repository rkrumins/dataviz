/**
 * useProviderTypes — the live provider catalog (`GET /admin/providers/types`),
 * merged with this bundle's brand visuals (`PROVIDER_VISUALS`), falling back
 * to the offline snapshot (`STATIC_PROVIDER_TYPES`) while the query is
 * loading or if it never resolves.
 *
 * Same pattern as `useBlankScopeOptions.ts`: one React Query cache per
 * `queryKey`, shared across every consumer that mounts this hook, and a
 * long `staleTime` since the catalog is effectively static per deployment.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { providerService } from '@/services/providerService'
import { mergeCatalog, type ProviderTypeEntry } from '@/services/providerTypes'

export interface UseProviderTypesResult {
    types: ProviderTypeEntry[]
    byId: Record<string, ProviderTypeEntry>
    isLoading: boolean
    /** Where `types` actually came from — 'backend' once the live catalog
     *  has resolved at least one row this session; 'static' before that
     *  (including a query that errors, and a resolved-but-empty response,
     *  which `mergeCatalog` also answers from the snapshot). */
    source: 'backend' | 'static'
}

export function useProviderTypes(): UseProviderTypesResult {
    const q = useQuery({
        queryKey: ['providers', 'types'],
        queryFn: () => providerService.listTypes(),
        staleTime: Infinity,
        retry: 1,
    })

    return useMemo(() => {
        const types = mergeCatalog(q.data)
        const byId: Record<string, ProviderTypeEntry> = {}
        for (const t of types) byId[t.id] = t
        return {
            types,
            byId,
            isLoading: q.isLoading,
            source: q.data?.length ? 'backend' : 'static',
        }
    }, [q.data, q.isLoading])
}
