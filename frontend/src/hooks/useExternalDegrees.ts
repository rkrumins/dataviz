/**
 * useExternalDegrees — TOTAL lineage degrees per loaded URN, fetched
 * once per hydration settle from `/nodes/degree`.
 *
 * Powers each card's lineage ports: whether it has lineage at all, even
 * with no line of it drawn (lineagePorts.ts). Never what lies outside the
 * view — that is where the projection places a far end. The backend counts
 * per-node adjacency with label-bucketed seeks and caches by chunk.
 *
 * Resilience contract: a URN absent from `totals` is UNKNOWN — callers
 * must render nothing for it, never "zero" (a degraded backend must not
 * create false "no lineage" claims). Fetching is additive and
 * deduplicated per URN, and an answer is kept whatever the canvas does
 * while it is in flight: only a provider switch drops it. A URN the
 * server left out of its answer, or whose request failed, is reported in
 * `failed` and asked again on this hook's own backoff
 * (lookupRetryDelayMs) — not on the next canvas change, which on an idle
 * canvas never comes. A pass stops at its first failed chunk rather than
 * send the rest to a struggling server; they are failed with it and
 * asked on the retry. A reader that cannot count (501) is left alone:
 * nothing is asked again and nothing reads as failed.
 *
 * Flows are counted by type, never the stored :AGGREGATED roll-up cells.
 * Whether a card holds roll-up cells is asked for besides
 * (`includeRollups`): that is how a collapsed container whose lineage all
 * sits below it says it has some. A server that ignores the flag answers
 * flows alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { lookupRetryDelayMs } from '@/config/polling'
import { useGraphProvider } from '@/providers'
import type { NodeDegree } from '@/providers/GraphDataProvider'
import { useCanvasStore, useCanvasVersion } from '@/store/canvas'
import { useViewLineageEdgeTypes } from '@/hooks/useViewSchema'

const CHUNK_SIZE = 400
const SETTLE_MS = 800

type Degree = NodeDegree

const NO_TOTALS: ReadonlyMap<string, Degree> = new Map()
const NONE_FAILED: ReadonlySet<string> = new Set()

export interface ExternalDegrees {
  totals: ReadonlyMap<string, Degree>
  /** URNs whose count failed or came back absent — being asked again.
   *  Each leaves the set when it is answered. */
  failed: ReadonlySet<string>
}

export function useExternalDegrees(enabled: boolean): ExternalDegrees {
  const provider = useGraphProvider()
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const flowTypes = useMemo(
    () => lineageEdgeTypes.filter(t => t.toUpperCase() !== 'AGGREGATED'),
    [lineageEdgeTypes],
  )
  const canvasVersion = useCanvasVersion()
  const [totals, setTotals] = useState<ReadonlyMap<string, Degree>>(NO_TOTALS)
  const [failed, setFailed] = useState<ReadonlySet<string>>(NONE_FAILED)
  // The provider that answered 501. Keyed on it, so a switch clears it.
  const [unsupportedBy, setUnsupportedBy] = useState<unknown>(null)
  // Bumped when a retry is due, to run the settle again.
  const [wake, setWake] = useState(0)
  // Asked for (or answered): never asked again. Cleared per URN to retry.
  const askedRef = useRef<Set<string>>(new Set())
  const failuresRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Bumped on a provider switch. A total is a fact about ONE graph: an
  // answer that lands after the switch is dropped.
  const generationRef = useRef(0)

  // Provider switch — all prior totals belong to another graph.
  useEffect(() => {
    generationRef.current += 1
    askedRef.current = new Set()
    failuresRef.current = 0
    const raf = requestAnimationFrame(() => {
      setTotals(NO_TOTALS)
      setFailed(NONE_FAILED)
    })
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = undefined
    }
  }, [provider])

  const supported = enabled && typeof provider.getNodeDegrees === 'function' && unsupportedBy !== provider

  useEffect(() => {
    if (!supported) return
    const timer = setTimeout(async () => {
      const urns = useCanvasStore.getState().nodes
        .map(n => n.id)
        .filter(id => id && !id.startsWith('logical:') && !askedRef.current.has(id))
      if (urns.length === 0) return
      const generation = generationRef.current
      urns.forEach(u => askedRef.current.add(u))
      const answered: string[] = []
      const missed: string[] = []
      for (let i = 0; i < urns.length; i += CHUNK_SIZE) {
        const chunk = urns.slice(i, i + CHUNK_SIZE)
        let res: Record<string, Degree>
        try {
          res = await provider.getNodeDegrees!(
            chunk,
            flowTypes.length > 0 ? flowTypes : undefined,
            { includeRollups: true },
          )
        } catch (err) {
          if (generation !== generationRef.current) return
          if ((err as { status?: number }).status === 501) {
            setUnsupportedBy(provider)
            setFailed(NONE_FAILED)
            return
          }
          // Unknown, not zero — this chunk and the ones not yet asked.
          missed.push(...urns.slice(i))
          break
        }
        if (generation !== generationRef.current) return
        for (const urn of chunk) (res[urn] ? answered : missed).push(urn)
        setTotals(prev => {
          const next = new Map(prev)
          for (const [urn, d] of Object.entries(res)) next.set(urn, d)
          return next
        })
      }
      setFailed(prev => {
        if (prev.size === 0 && missed.length === 0) return prev
        const next = new Set(prev)
        answered.forEach(u => next.delete(u))
        missed.forEach(u => next.add(u))
        return next
      })
      if (missed.length === 0) { failuresRef.current = 0; return }
      missed.forEach(u => askedRef.current.delete(u))
      failuresRef.current += 1
      if (retryTimerRef.current === undefined) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = undefined
          setWake(n => n + 1)
        }, lookupRetryDelayMs(failuresRef.current))
      }
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [supported, provider, flowTypes, canvasVersion, wake])

  return { totals, failed }
}
