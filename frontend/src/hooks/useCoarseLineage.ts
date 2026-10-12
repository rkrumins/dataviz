/**
 * useCoarseLineage — the ONE request the entity drawer makes when it opens:
 * the focal's rollup cells (`/trace/closure` with `grain: 'coarse'`).
 *
 * Which entities feed this one, which does it feed, and how many flows each
 * carries — one index seek, ~80 ms for a 600-column table, where walking the
 * table's columns costs ~3,000 nodes over several pages. The drawer shows
 * this at once and fetches columns only when the reader opens an entity
 * (`useLensWalk`).
 *
 * A provider without the rollup lane (a draft, a versioned branch) answers a
 * coarse request with the fine walk and says `grain: 'fine'`: that is
 * reported as `servedFine`, and the caller walks properly instead.
 *
 * One request per focal, cached for the life of the mount (a failure is
 * cached too — no retry storm), aborted when the focal changes.
 */
import { useEffect, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { toLensClosure, type LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

export type CoarseLineageStatus = 'idle' | 'loading' | 'done' | 'error' | 'unsupported'

export interface CoarseLineage {
  status: CoarseLineageStatus
  model: LensWalkModel | null
  /** The provider has no rollup lane and answered with the fine walk. */
  servedFine: boolean
  /** The cells were cut at the page's ceiling: the answer is a floor. */
  truncated: boolean
}

/** Answer-less states are module constants, so a re-render with an
 *  unstable provider cannot become a request loop (setState bails out on an
 *  identical reference). */
const blank = (status: CoarseLineageStatus): CoarseLineage =>
  Object.freeze({ status, model: null, servedFine: false, truncated: false })
const IDLE = blank('idle')
const LOADING = blank('loading')
const ERRORED = blank('error')
const UNSUPPORTED = blank('unsupported')

export function useCoarseLineage(urn: string | null, provider: GraphDataProvider | null | undefined): CoarseLineage {
  // Settled answers, per focal — the cache. Held in state so an answer
  // arriving re-renders; derived below for every other state, so nothing is
  // set synchronously in an effect.
  const [answers, setAnswers] = useState<ReadonlyMap<string, CoarseLineage>>(() => new Map())
  // A different provider is a different data source: its answers start over.
  const [answersFor, setAnswersFor] = useState(provider)
  if (answersFor !== provider) {
    setAnswersFor(provider)
    setAnswers(new Map())
  }
  const supported = typeof provider?.traceClosure === 'function'
  const settled = urn ? answers.get(urn) : undefined

  useEffect(() => {
    if (!urn || !supported || settled) return
    const controller = new AbortController()
    const settle = (answer: CoarseLineage) => {
      if (controller.signal.aborted) return
      setAnswers((prev) => new Map(prev).set(urn, answer))
    }
    void (async () => {
      try {
        const res = await provider!.traceClosure!(
          { urn, direction: 'both', upstreamDepth: 1, downstreamDepth: 1, grain: 'coarse' },
          { signal: controller.signal },
        )
        settle({
          status: 'done',
          model: toLensClosure(res, urn),
          servedFine: res.grain !== 'coarse',
          truncated: !!res.truncated,
        })
      } catch (err) {
        settle(isUnsupported(err) ? UNSUPPORTED : ERRORED)
      }
    })()
    return () => controller.abort()
  }, [urn, provider, supported, settled])

  if (!urn) return IDLE
  if (!supported) return UNSUPPORTED
  return settled ?? LOADING
}

/** A 501 / NotImplemented refusal, however the transport spelled it. */
function isUnsupported(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status
  if (status === 501) return true
  const message = (err as { message?: string } | undefined)?.message ?? ''
  return message.includes('trace_closure_unsupported')
}
