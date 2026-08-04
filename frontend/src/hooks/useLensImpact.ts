/**
 * useLensImpact — transitive reach counts for the Lineage Lens focal.
 *
 * "What does this feed, in total?" is the question business users open
 * Focus mode to answer; the direct-neighbor tallies can't. This hook
 * asks the provider's level-aware trace for the focal's transitive
 * upstream/downstream URN sets (bounded depth) and reports their sizes.
 *
 * Contract mirrors useLensLineage: one fetch per focal per lens
 * session (explicit retry only — never a loop), a session token so a
 * closed lens can't resurrect stale results, lens-local state that is
 * never written to the canvas store, and honesty first — a truncated
 * trace surfaces as `truncated` ("N+" in the UI), and a provider
 * without the capability yields NOTHING rather than a guessed zero.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

/** Bounded trace depth per direction — stated in the UI copy. */
export const IMPACT_DEPTH = 10
/**
 * Settle time before a focal's reach is measured. This is the single
 * heaviest query the lens makes, and firing it on every hop put it on
 * the critical path of navigation — walking five nodes deep queued five
 * multi-hop traces the user never waited to read. Walking stays
 * instant; only the focal you actually stop on gets measured.
 */
export const IMPACT_DEBOUNCE_MS = 300

export interface LensImpact {
  /** Distinct entities transitively upstream / downstream (at the
   *  focal's own rollup level, within IMPACT_DEPTH hops). */
  up: number
  down: number
  /** Server stopped early (max nodes / timeout) — counts are floors. */
  truncated: boolean
}

export interface LensImpactData {
  impact: Map<string, LensImpact>
  status: Map<string, 'loading' | 'done' | 'error'>
  retry: (nodeId: string) => void
}

interface ImpactState {
  impact: Map<string, LensImpact>
  status: Map<string, 'loading' | 'done' | 'error'>
}

const emptyState = (): ImpactState => ({ impact: new Map(), status: new Map() })

export function useLensImpact(
  /** Current focal node, or null when the lens is closed. */
  focalId: string | null,
  provider: GraphDataProvider | null,
): LensImpactData {
  const [state, setState] = useState<ImpactState>(emptyState)
  const startedRef = useRef<Set<string>>(new Set())
  const sessionRef = useRef(0)

  const fetchImpact = useCallback(async (urn: string) => {
    // Optional provider capability — absent means UNKNOWN, and the UI
    // shows nothing (never an invented zero).
    if (!provider?.traceAtLevel) return
    const session = sessionRef.current
    startedRef.current.add(urn)
    setState(prev => {
      const status = new Map(prev.status)
      status.set(urn, 'loading')
      return { ...prev, status }
    })
    try {
      const res = await provider.traceAtLevel({
        urn,
        direction: 'both',
        upstreamDepth: IMPACT_DEPTH,
        downstreamDepth: IMPACT_DEPTH,
        level: 'auto',
      })
      if (session !== sessionRef.current) return
      setState(prev => {
        const impact = new Map(prev.impact)
        impact.set(urn, {
          up: res.upstreamUrns.size,
          down: res.downstreamUrns.size,
          truncated: res.truncated,
        })
        const status = new Map(prev.status)
        status.set(urn, 'done')
        return { impact, status }
      })
    } catch {
      if (session !== sessionRef.current) return
      setState(prev => {
        const status = new Map(prev.status)
        status.set(urn, 'error')
        return { ...prev, status }
      })
    }
  }, [provider])

  // Session lifecycle: measure each visited focal once; clear on close.
  useEffect(() => {
    if (!focalId) {
      if (startedRef.current.size > 0) {
        sessionRef.current += 1
        startedRef.current.clear()
        setState(emptyState())
      }
      return
    }
    if (startedRef.current.has(focalId)) return
    const t = window.setTimeout(() => void fetchImpact(focalId), IMPACT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [focalId, fetchImpact])

  const retry = useCallback((nodeId: string) => void fetchImpact(nodeId), [fetchImpact])

  return { impact: state.impact, status: state.status, retry }
}
