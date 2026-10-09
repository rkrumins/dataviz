import { useEffect } from 'react'
import { POLLING_INTERVALS, PROVIDER_RETRY_MAX_ATTEMPTS, withJitter } from '@/config/polling'
import { invalidateAggregatedEdgesForScope } from '@/hooks/useAggregatedLineage'

/** First ask, and the ceiling the fast attempts widen to. */
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
 *
 * WHY EVERY DELAY IS JITTERED, CAPPED AND SCOPED. This arms on a shared
 * condition: one node rotating puts every viewer of every graph on that
 * shard into `failing_over` within the same second. Unjittered, all of them
 * asked again at exactly t+3s, t+9s, t+21s — a synchronised fan-out at a
 * node that is mid-election, which is the moment it can least afford one.
 * And a retry that comes back `failing_over` leaves the reason unchanged, so
 * the effect never re-runs: without a cap the 30s loop ran for the life of
 * the tab, backgrounded or not.
 *
 * So: each delay is jittered, the fast attempts are capped the way the
 * canvas's own provider retry is (`PROVIDER_RETRY_MAX_ATTEMPTS`) before
 * dropping to the slow background cadence, the tick is skipped while the tab
 * is hidden, and the invalidation is scoped to the provider that is actually
 * failing over. That last one matters most: the global version bump made
 * EVERY mounted canvas refetch `POST /graph/edges/aggregated` — the most
 * expensive endpoint in the app, fanned into chunks, and a POST, so nothing
 * client-side absorbs it.
 */
export function useFailoverRetry(
  staleReason: string | null | undefined,
  scopeKey?: string,
): void {
  useEffect(() => {
    if (staleReason !== 'failing_over') return

    let attempt = 0
    let timer: ReturnType<typeof setTimeout>

    // Fast while a promotion plausibly finishes, then the same slow floor the
    // canvas's provider retry falls back to. It never stops entirely: recovery
    // must not need a click.
    const nextDelay = () => (
      attempt <= PROVIDER_RETRY_MAX_ATTEMPTS
        ? withJitter(Math.min(FIRST_MS * 2 ** attempt, MAX_MS))
        : withJitter(POLLING_INTERVALS.providerRetrySlow)
    )

    const ask = () => {
      // A hidden tab pays nothing: nobody is looking at the banner this is
      // trying to clear, and the ask is a fan-out onto a node under stress.
      if (typeof document === 'undefined' || !document.hidden) {
        invalidateAggregatedEdgesForScope(scopeKey)
      }
      attempt += 1
      timer = setTimeout(ask, nextDelay())
    }
    timer = setTimeout(ask, withJitter(FIRST_MS))
    return () => clearTimeout(timer)
  }, [staleReason, scopeKey])
}
