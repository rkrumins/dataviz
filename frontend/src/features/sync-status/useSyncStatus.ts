import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { useBranchStore } from '@/store/branchStore'
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

/** When the graph a view reads finishes an update (behind, then in sync), refetch what the view
 *  shows: its hydration and schema (main's epoch) and its connections (the aggregated cache).
 *  While it was behind, reads showed the version the graph last finished; this brings the new one
 *  in, for every viewer of the page, whatever its canvas. It reads the header chip's poll, so it
 *  adds no request. */
export function useRefreshWhenGraphUpdated(wsId?: string | null, dataSourceId?: string | null, viewId?: string) {
  const fresh = useSyncStatus(wsId, dataSourceId, viewId).data?.versioned?.fresh
  const was = useRef<{ dataSourceId?: string | null; fresh?: boolean }>({})
  useEffect(() => {
    const prev = was.current
    if (prev.dataSourceId === dataSourceId && prev.fresh === false && fresh === true) {
      useBranchStore.getState().bumpMainEpoch()
      invalidateAggregatedEdges()
    }
    was.current = { dataSourceId, fresh }
  }, [dataSourceId, fresh])
}
