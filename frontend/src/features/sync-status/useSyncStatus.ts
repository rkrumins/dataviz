import { useQuery } from '@tanstack/react-query'
import { getSyncStatus, type SyncStatus } from './syncStatusApi'

export const SYNC_STATUS_KEY = ['sync-status'] as const

/** How often to re-read (ms): quickly while something is moving or behind, calmly otherwise.
 *  Read straight off the document — react-query calls this on every state change, so it must not
 *  run the whole verdict (which formats dates and numbers). */
export function syncPollInterval(doc: SyncStatus | undefined): number {
  if (!doc) return 30_000
  const v = doc.versioned
  const s = doc.summaries
  const moving = !!v && (v.status === 'projecting' || v.status === 'rebuilding' || (!v.fresh && !v.lastError))
  const job = !!s && (s.jobStatus === 'running' || s.jobStatus === 'pending' || (!!s.jobId && !s.jobStatus))
  return moving || job ? 3_000 : 30_000
}

/** A view's sync status (see `getSyncStatus`). Refetched on focus, and on publish/merge (the
 *  versioning mutations invalidate SYNC_STATUS_KEY). */
export function useSyncStatus(wsId?: string | null, dataSourceId?: string | null, viewId?: string) {
  return useQuery({
    queryKey: [...SYNC_STATUS_KEY, wsId, dataSourceId],
    queryFn: () => getSyncStatus(wsId!, dataSourceId!, viewId),
    enabled: !!wsId && !!dataSourceId,
    refetchInterval: (q) => syncPollInterval(q.state.data),
    refetchOnWindowFocus: true,
    staleTime: 2_000,
    retry: 1,
  })
}
