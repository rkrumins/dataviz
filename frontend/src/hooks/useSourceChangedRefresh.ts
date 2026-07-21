import { useEffect } from 'react'
import { aggregationService } from '@/services/aggregationService'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'

/**
 * Self-refresh the canvas after a source-changed rebuild completes.
 *
 * While the aggregated overlay is flagged `source_changed` (an external
 * load/signal set the stale marker and a rebuild is queued/running), the
 * aggregated-lineage hook keeps serving the cached previous rollup for
 * stale-while-revalidate and never re-hits the backend on a cache hit — so on
 * its own the blue "lineage is being recomputed" banner would linger until the
 * 5-min cache TTL. This hook polls the CHEAP readiness endpoint (NOT the
 * expensive aggregated query — that would hammer FalkorDB for a large model
 * mid-rebuild) and, on the not-ready → ready transition that marks completion,
 * invalidates the aggregated cache ONCE: the resulting single refetch reads
 * the now-cleared marker, so the banner self-clears and fresh lineage appears
 * with no manual reload. Mirrors the readiness loop in
 * components/explorer/AggregationProgressBanner.
 *
 * No-op unless `staleReason === 'source_changed'` and `dataSourceId` is set.
 */
export function useSourceChangedRefresh(
  dataSourceId: string | null | undefined,
  staleReason: string | null | undefined,
  pollMs = 5000,
): void {
  useEffect(() => {
    if (staleReason !== 'source_changed' || !dataSourceId) return

    let cancelled = false
    let prevReady: boolean | undefined
    let consecutiveErrors = 0
    let poll: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (poll) {
        clearInterval(poll)
        poll = undefined
      }
    }

    const check = async () => {
      try {
        const res = await aggregationService.getReadiness(dataSourceId)
        consecutiveErrors = 0
        if (cancelled) return
        // Rebuild finished (not-ready → ready): drop the cached stale rollup
        // so the next fetch reads the cleared marker and the banner clears.
        if (prevReady === false && res.isReady) invalidateAggregatedEdges()
        prevReady = res.isReady
        // A failed rebuild is terminal until the reconciler/user acts — the
        // banner honestly stays; stop the poll rather than spin on it.
        if (res.aggregationStatus === 'failed') stop()
      } catch {
        // Backend unreachable — stop after a few misses so we don't hammer;
        // a later stale response re-arms this effect (deps change).
        if (++consecutiveErrors >= 3) stop()
      }
    }

    void check()
    poll = setInterval(check, pollMs)
    return () => {
      cancelled = true
      stop()
    }
  }, [dataSourceId, staleReason, pollMs])
}
