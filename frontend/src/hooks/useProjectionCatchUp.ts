import { useEffect, useMemo, useRef, useState } from 'react'
import { aggregationService } from '@/services/aggregationService'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'

/**
 * Tell the board when a source's connections are still catching up.
 *
 * THE OUTAGE THIS EXISTS FOR. A source whose read cache trails its published
 * history serves main reads out of the version log instead. The canvas then
 * draws the cards and almost none of the wires between them — no error, no
 * empty state, no explanation. A reader drills into a container, sees one
 * edge where there should be dozens, and reasonably concludes the canvas is
 * broken. That silence cost a full day of frontend debugging for a condition
 * the backend already knew about.
 *
 * TWO SIGNALS, AND WHY BOTH. The aggregated-lineage response already says the
 * rollup layer answered short (`staleReason`), but it does not say WHY, and
 * several of its reasons are ordinary caps rather than a wedge. So the stale
 * reason is only the PROMPT: when it lands in `ROLLUP_INTEGRITY_REASONS` we
 * go ask the one endpoint that answers authoritatively — readiness, whose
 * `projectorCurrent === false` is the affirmative "this source is behind".
 * A healthy canvas matches none of those reasons and therefore issues NO
 * extra requests at all; the poll is the price of an already-degraded board.
 *
 * NULL IS NOT HEALTHY, BUT IT IS NOT A BANNER EITHER. `projectorCurrent` is
 * null for an unversioned source, for a versioned graph pinned to no graph
 * target, and when the store could not be read. Only `=== false` raises the
 * notice: an unknown reading must never be rendered as "up to date", and it
 * must equally never accuse a healthy source of being behind.
 *
 * WHY IT ALSO INVALIDATES. On the false -> true edge the source has caught
 * up, but the canvas is still holding the short rollups it cached during the
 * wedge, and the aggregated cache would serve those for its full TTL. So the
 * recovery edge drops that cache once: the refetch reads the now-complete
 * answer, the missing wires appear, and the notice clears itself with them.
 * Mirrors the readiness loop in `useSourceChangedRefresh`.
 */

/**
 * Stale reasons that mean the rollup layer answered SHORT — the answer on
 * screen is missing connections it should have had.
 *
 * `source_changed` is deliberately NOT here. That one is a rebuild in
 * flight: it has its own banner, its own self-refresh, and it is serving the
 * PREVIOUS complete answer rather than a short one. Folding it in here would
 * make every ordinary rebuild accuse the source of being behind.
 */
export const ROLLUP_INTEGRITY_REASONS: ReadonlySet<string> = new Set([
  // A rollup sub-query or a materialised-edge batch failed and was swallowed.
  'degraded',
  // No rollups have been computed for this graph state.
  'unmaterialized',
  // Cells predating the depth-stamp contract; nested pairs read degenerate.
  'legacy_cells',
  // A read served from the version log derived its rollups and hit a bound:
  // the scope cap or the containment hop bound. These are the shapes a source
  // that is behind actually produces, which is why they prompt the check.
  'derive_scope_cap',
  'derive_hop_bound',
])

/** Is this stale reason worth asking the projector about? */
export function shouldAskProjector(staleReason: string | null | undefined): boolean {
  return !!staleReason && ROLLUP_INTEGRITY_REASONS.has(staleReason)
}

/**
 * What the board says. PLAIN LANGUAGE ONLY — this renders on the canvas, in
 * front of an end user, so it may never contain "projection", "watermark",
 * "commit seq", "rollup" or "AGGREGATED". It also never blames the reader:
 * the whole failure mode was people assuming they had broken their own view.
 */
export function catchUpMessage(commitsBehind: number | null): string {
  const scale = commitsBehind && commitsBehind > 0
    ? `This source is about ${commitsBehind.toLocaleString()} recent ${commitsBehind === 1 ? 'change' : 'changes'} behind, so some`
    : 'This source’s data is still being brought up to date, so some'
  return `${scale} connections between items may not appear yet. Nothing is wrong with your view — this clears on its own.`
}

export interface ProjectionCatchUp {
  /** The source is affirmatively behind. Never true from an unknown reading. */
  catchingUp: boolean
  /** How far behind, when the wire gave a number. Null means "not said". */
  commitsBehind: number | null
}

const IDLE: ProjectionCatchUp = { catchingUp: false, commitsBehind: null }

export function useProjectionCatchUp(
  dataSourceId: string | null | undefined,
  staleReason: string | null | undefined,
  pollMs = 15000,
): ProjectionCatchUp {
  const [catchingUp, setCatchingUp] = useState(false)
  const [commitsBehind, setCommitsBehind] = useState<number | null>(null)
  // Previous reading, for the recovery edge. A ref rather than the state
  // itself so the transition is decided outside the updater — a setState
  // updater can run twice and must not carry the cache invalidation.
  const wasBehind = useRef(false)

  const ask = shouldAskProjector(staleReason) && !!dataSourceId

  useEffect(() => {
    wasBehind.current = false
    if (!ask || !dataSourceId) {
      // Same-value setState bails out, so this costs nothing on the common
      // path where the canvas was never behind in the first place.
      setCatchingUp(false)
      setCommitsBehind(null)
      return
    }

    let cancelled = false
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
        // ONLY an explicit false. Null is unknown, and unknown is neither
        // "behind" nor "up to date" — it is simply not something to claim.
        const behind = res.projectorCurrent === false
        if (wasBehind.current && !behind) invalidateAggregatedEdges()
        wasBehind.current = behind
        setCatchingUp(behind)
        setCommitsBehind(behind ? (res.projectionCommitsBehind ?? null) : null)
      } catch {
        // Readiness unreachable (or not permitted): stop after a few misses
        // rather than hammer it. A later stale answer re-arms this effect.
        if (++consecutiveErrors >= 3) stop()
      }
    }

    void check()
    poll = setInterval(check, pollMs)
    return () => {
      cancelled = true
      stop()
    }
  }, [ask, dataSourceId, pollMs])

  // Stable identity: this value is read by the canvas, whose memo dep arrays
  // are extremely sensitive to a new object every render.
  return useMemo(
    () => (catchingUp ? { catchingUp, commitsBehind } : IDLE),
    [catchingUp, commitsBehind],
  )
}
