/**
 * The real relationships a roll-up line stands for — between entities inside its two cards, at any
 * depth — read from the view's own provider (so a draft sees its own). A two-way line reads both
 * directions in the one query.
 *
 * Keyed under the versioning namespace, like `useRelationshipsBetween`, so a save refreshes it.
 */
import { useQuery } from '@tanstack/react-query'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import type { EdgesBeneath } from '@/providers/GraphDataProvider'

export function useRelationshipsBeneath(source: string, target: string, bothWays: boolean, enabled: boolean) {
  const { provider, providerVersion } = useGraphProviderContext()
  const scope = (provider as { scopeKey?: string } | null)?.scopeKey ?? ''
  const read = provider?.getEdgesBeneath?.bind(provider)
  return useQuery({
    queryKey: [...VERSIONING_KEYS.all, 'beneath', scope, providerVersion, source, target, bothWays],
    queryFn: async (): Promise<EdgesBeneath> => {
      const parts = await Promise.all(bothWays ? [read!(source, target), read!(target, source)] : [read!(source, target)])
      const edges = parts.flatMap((p) => p.edges)
      return { edges, total: edges.length, truncated: parts.some((p) => p.truncated) }
    },
    enabled: enabled && !!read && !!source && !!target,
    staleTime: 30_000,
  })
}
