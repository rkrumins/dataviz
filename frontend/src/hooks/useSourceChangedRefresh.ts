import { useEffect } from 'react'
import { withJitter } from '@/config/polling'
import { aggregationService } from '@/services/aggregationService'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'

/**
 * After three consecutive failures the poll drops to this floor rather than
 * stopping for the life of the canvas. It used to stop dead, which left the
 * blue "lineage is being recomputed" banner asserting a rebuild that had
 * very likely finished — with nothing left running to clear it.
 */
const AFTER_ERRORS_MS = 5 * 60_000

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
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (baseMs: number) => {
      if (cancelled) return
      timer = setTimeout(check, withJitter(baseMs))
    }

    const check = async () => {
      if (cancelled) return
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
        if (res.aggregationStatus === 'failed') return
        arm(pollMs)
      } catch {
        // Backend unreachable. Back off hard after a few misses rather than
        // hammer — but keep a slow, jittered ask alive: this loop is the only
        // thing that takes the "recomputing" banner down, and stopping for
        // good left it asserting a rebuild that had already finished.
        if (cancelled) return
        if (++consecutiveErrors >= 3) {
          consecutiveErrors = 0
          arm(AFTER_ERRORS_MS)
          return
        }
        arm(pollMs)
      }
    }

    void check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [dataSourceId, staleReason, pollMs])
}
