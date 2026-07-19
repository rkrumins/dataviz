/**
 * useExternalDegrees — TOTAL lineage degrees per loaded URN, fetched
 * once per hydration settle from `/nodes/degree`.
 *
 * Powers the curated-view "lineage outside this view" cue: external
 * degree = total (full graph) − internal (edges already loaded). The
 * strictly-cheaper alternative to an XOR set-membership query — the
 * backend counts per-node adjacency with label-bucketed seeks and
 * caches by chunk.
 *
 * Resilience contract: a URN absent from the map is UNKNOWN — callers
 * must render nothing for it, never "zero" (a degraded backend must not
 * create false "no lineage" claims). Failed chunks are re-queued for
 * the next settle. Fetching is additive and deduplicated per URN.
 */
import { useEffect, useRef, useState } from 'react'
import { useGraphProvider } from '@/providers'
import { useCanvasStore, useCanvasVersion } from '@/store/canvas'
import { useViewLineageEdgeTypes } from '@/hooks/useViewSchema'

const CHUNK_SIZE = 400
const SETTLE_MS = 800

export function useExternalDegrees(enabled: boolean): Map<string, { in: number; out: number }> {
  const provider = useGraphProvider()
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const canvasVersion = useCanvasVersion()
  const [totals, setTotals] = useState<Map<string, { in: number; out: number }>>(() => new Map())
  const fetchedRef = useRef<Set<string>>(new Set())

  // Provider switch — all prior totals belong to another graph.
  useEffect(() => {
    fetchedRef.current = new Set()
    const raf = requestAnimationFrame(() => setTotals(new Map()))
    return () => cancelAnimationFrame(raf)
  }, [provider])

  useEffect(() => {
    if (!enabled) return
    if (typeof provider.getNodeDegrees !== 'function') return
    let cancelled = false
    const timer = setTimeout(async () => {
      const urns = useCanvasStore.getState().nodes
        .map(n => n.id)
        .filter(id => id && !id.startsWith('logical:') && !fetchedRef.current.has(id))
      if (urns.length === 0) return
      urns.forEach(u => fetchedRef.current.add(u))
      for (let i = 0; i < urns.length; i += CHUNK_SIZE) {
        const chunk = urns.slice(i, i + CHUNK_SIZE)
        try {
          const res = await provider.getNodeDegrees!(
            chunk,
            lineageEdgeTypes.length > 0 ? lineageEdgeTypes : undefined,
          )
          if (cancelled) return
          setTotals(prev => {
            const next = new Map(prev)
            for (const [urn, d] of Object.entries(res)) next.set(urn, d)
            return next
          })
        } catch {
          // Unknown, not zero — re-queue the chunk for the next settle.
          chunk.forEach(u => fetchedRef.current.delete(u))
        }
      }
    }, SETTLE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [enabled, provider, lineageEdgeTypes, canvasVersion])

  return totals
}
