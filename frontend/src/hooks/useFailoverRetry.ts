import { useEffect } from 'react'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'

/** First ask, and the ceiling the gap widens to. */
const FIRST_MS = 3000
const MAX_MS = 30_000

/**
 * Keep asking while the graph store node holding this graph is being
 * replaced.
 *
 * The board says "reconnecting … retrying automatically" and offers no
 * Retry button, on the promise that it comes back on its own. A single
 * timeout does not keep that promise: the retry that comes back
 * `failing_over` again sets the SAME stale reason, so nothing re-renders,
 * nothing re-arms, and the banner sits there until the module cache
 * expires five minutes later. Nothing else covers it either —
 * `failing_over` is not an integrity reason, so the catch-up poll ignores
 * it, and the source-changed poll only fires on its own reason.
 *
 * The first ask is early because most promotions are quick; the gap then
 * widens, because a cluster failover cannot finish inside
 * `cluster-node-timeout` plus an election and asking every three seconds
 * through it is just noise. It stops the moment the reason clears.
 */
export function useFailoverRetry(staleReason: string | null | undefined): void {
  useEffect(() => {
    if (staleReason !== 'failing_over') return

    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const ask = () => {
      invalidateAggregatedEdges()
      attempt += 1
      timer = setTimeout(ask, Math.min(FIRST_MS * 2 ** attempt, MAX_MS))
    }
    timer = setTimeout(ask, FIRST_MS)
    return () => clearTimeout(timer)
  }, [staleReason])
}
