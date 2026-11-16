/**
 * What changed in a graph since you last looked, and what you watch in it.
 *
 * The digest is read once when a graph opens and kept: no polling, no refetch on focus. It sits
 * under `viewCommits`, so your own publish, merge, undo or restore — which refresh the history —
 * refresh it too, and "Mark as seen" marks the version you just made as well. Marking seen reads
 * it again rather than working out the answer here: every figure stays the server's.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/services/versioningApiService'
import type { GraphWatching } from '@/services/versioningApiService'
import { VERSIONING_KEYS } from './useVersioning'

export const DIGEST_KEYS = {
  digest: (ws?: string, gid?: string | null) =>
    [...VERSIONING_KEYS.all, 'viewCommits', ws, gid, 'digest'] as const,
  watch: (ws?: string, gid?: string | null) =>
    [...VERSIONING_KEYS.all, 'watch', ws, gid] as const,
}

export function useGraphDigest(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: DIGEST_KEYS.digest(wsId, graphId),
    queryFn: () => api.getGraphDigest(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })
}

/** Move the marker to `seq` (the head the digest showed), then read the digest again. */
export function useMarkDigestSeen(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (seq: number) => api.markDigestSeen(wsId, graphId, seq),
    onSuccess: () => qc.invalidateQueries({ queryKey: DIGEST_KEYS.digest(wsId, graphId) }),
  })
}

export function useGraphWatch(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: DIGEST_KEYS.watch(wsId, graphId),
    queryFn: () => api.getGraphWatch(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
}

/** Watch or stop watching the graph (`urn` absent) or an entity in it. The answer is what you
 *  watch now, straight into the cache the header and the entity panel share. */
export function useSetWatch(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ on, urn }: { on: boolean; urn?: string }) =>
      on ? api.watchGraph(wsId, graphId, urn) : api.unwatchGraph(wsId, graphId, urn),
    onSuccess: (watching: GraphWatching) => qc.setQueryData(DIGEST_KEYS.watch(wsId, graphId), watching),
  })
}
