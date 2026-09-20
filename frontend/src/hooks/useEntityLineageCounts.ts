/**
 * useEntityLineageCounts — the entity drawer's headline lineage counts,
 * read from the SAME server walk the Focus Lens reads.
 *
 * WHY THIS EXISTS. The drawer used to count the lineage edges it happened
 * to hold: the canvas's PROJECTED set (rolled up to visible ancestors and
 * bundled by `useEdgeProjection`) plus a bounded per-node fetch. The Lens
 * reads `/trace/closure`. Two sources, two answers, one label — and users
 * reported the disagreement. Two mechanisms made it structural:
 *
 *   • SYNTHETIC ROLLUPS. A resolved ontology routinely lists `AGGREGATED`
 *     among its lineage types, so the drawer's fetch counted the
 *     aggregation worker's own materialised cells as if they were flows a
 *     data source had declared — once per coarser grain above the real
 *     one. The closure strips them at a single seam (`_real_lineage_types`,
 *     backend `context_engine.py`), which is what took "5 in / 4 out" off a
 *     column with two real neighbours. Counting locally put it back.
 *
 *   • CONTAINERS. A container carries no edges of its own — its contents
 *     do. The closure seeds a container focus from its lineage-bearing
 *     descendants, so a table's count includes what its columns reach.
 *     Matching only edges whose endpoint IS the focal reported ~0 for
 *     exactly the entities users click most in a large graph.
 *
 * So the count is not re-derived here. One depth-1 closure per focal
 * answers it: `upstreamUrns` / `downstreamUrns` are the distinct lineage
 * partners the walk discovered, deduped server-side.
 *
 * Bounded by construction: ONE request per focal, cached for the lifetime
 * of the mount, aborted when the focal changes. A provider without the
 * closure lane reports `unsupported` and the caller keeps its local
 * derivation rather than showing a zero it cannot stand behind.
 */
import { useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

export type EntityLineageCountsStatus =
  | 'idle'
  | 'loading'
  | 'done'
  | 'error'
  | 'unsupported'

export interface EntityLineageCounts {
  /** Distinct 1-hop upstream partners, or null until the walk answers. */
  upstream: number | null
  /** Distinct 1-hop downstream partners, or null until the walk answers. */
  downstream: number | null
  /**
   * The walk did not finish (node budget, deadline, or a container whose
   * contents outran the seed reserve). The counts are a FLOOR, never a
   * total, and the caller must say so.
   */
  truncated: boolean
  status: EntityLineageCountsStatus
}

/**
 * The answer-less states are module constants, not fresh objects.
 *
 * `setCounts` with an identical reference lets React bail out of the
 * re-render — which is what keeps an UNSTABLE `provider` prop (a caller
 * that builds one inline) from becoming a request-per-render loop. A
 * literal here spun the lane until the heap gave out.
 */
const blank = (status: EntityLineageCountsStatus): EntityLineageCounts =>
  Object.freeze({ upstream: null, downstream: null, truncated: false, status })

const IDLE = blank('idle')
const PENDING = blank('loading')
const UNSUPPORTED = blank('unsupported')
const ERRORED = blank('error')

export function useEntityLineageCounts(
  nodeId: string | null,
  provider: GraphDataProvider | null | undefined,
  lineageEdgeTypes: string[],
): EntityLineageCounts {
  const [counts, setCounts] = useState<EntityLineageCounts>(IDLE)
  // One answer per focal, kept for the life of the mount: re-opening the
  // drawer on a node already asked about must not re-ask.
  const cacheRef = useRef<Map<string, EntityLineageCounts>>(new Map())
  // Bumped on every focal change; a response whose session no longer
  // matches belongs to a focal the user has already left.
  const sessionRef = useRef(0)

  // The types list is a fresh array every render for most callers; key on
  // its content so the effect doesn't re-fire on identity alone.
  const typesKey = lineageEdgeTypes.join(',')

  useEffect(() => {
    if (!nodeId) {
      setCounts(IDLE)
      return
    }
    const cached = cacheRef.current.get(nodeId)
    if (cached) {
      setCounts(cached)
      return
    }
    if (typeof provider?.traceClosure !== 'function') {
      setCounts(UNSUPPORTED)
      return
    }

    const session = ++sessionRef.current
    const controller = new AbortController()
    setCounts(PENDING)

    void (async () => {
      try {
        const res = await provider.traceClosure!(
          {
            urn: nodeId,
            direction: 'both',
            upstreamDepth: 1,
            downstreamDepth: 1,
            // null = every lineage type the ontology declares. The server
            // strips its own synthetic rollups either way.
            lineageEdgeTypes: lineageEdgeTypes.length > 0 ? lineageEdgeTypes : null,
          },
          { signal: controller.signal },
        )
        if (session !== sessionRef.current) return
        const next: EntityLineageCounts = {
          upstream: res.upstreamUrns.size,
          downstream: res.downstreamUrns.size,
          truncated: !!res.truncated || !!res.seedTruncated,
          status: 'done',
        }
        cacheRef.current.set(nodeId, next)
        setCounts(next)
      } catch (err) {
        if (session !== sessionRef.current) return
        if (controller.signal.aborted) return
        // A provider that cannot walk (a draft overlay, a versioned branch
        // without the lane) answers 501. That is not an error the user can
        // act on — it means "fall back", and it is cached so one refusal
        // doesn't become a request per render.
        const next = isUnsupported(err) ? UNSUPPORTED : ERRORED
        if (next === UNSUPPORTED) cacheRef.current.set(nodeId, next)
        setCounts(next)
      }
    })()

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, provider, typesKey])

  return counts
}

/** A 501 / NotImplemented refusal, however the transport spelled it. */
function isUnsupported(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status
  if (status === 501) return true
  const message = (err as { message?: string } | undefined)?.message ?? ''
  return message.includes('trace_closure_unsupported')
}
