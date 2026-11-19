/**
 * Narrowing a view the server places (made from a query, or a subset view) loads every member
 * the narrowing holds into the layer the view draws it in — not only the rows its layers had
 * paged in. A narrowing filters what is loaded; in a view of 50,000 members, the first page of
 * each layer holds a fraction of it.
 *
 * Loaded a batch at a time behind what the reader is doing (`background`), and reported as it
 * goes: how many are in, and how many the view draws nowhere. Put away — and what is in
 * flight stopped — when the narrowing changes or is cleared, or the view changes.
 */
import { useEffect, useMemo, useState } from 'react'

import { loadIntoCanvas } from '@/features/served-placement/loadIntoCanvas'
import type { ServedPlacements } from '@/features/served-placement/servedPlacements'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useCanvasStore } from '@/store/canvas'
import type { MembershipResult } from '@/types/membership'

export interface NarrowLoadProgress {
  /** Loaded, or already on the canvas in their layer. */
  done: number
  total: number
  /** The view draws these nowhere. */
  outside: number
  failed: number
  finished: boolean
}

export function useNarrowServedLoad(opts: {
  served: ServedPlacements | null
  provider: GraphDataProvider
  result: MembershipResult | null
  containmentEdgeTypes: string[]
  lineageEdgeTypes: string[]
}): NarrowLoadProgress | null {
  const { served, provider, result, containmentEdgeTypes, lineageEdgeTypes } = opts
  const [progress, setProgress] = useState<{ key: string; value: NarrowLoadProgress } | null>(null)
  const key = result ? `${result.specHash}|${result.dataVersion}` : ''
  // Edge types are read when a load starts; a caller's fresh arrays of the same types load nothing again.
  const typesKey = `${containmentEdgeTypes.join(',')}|${lineageEdgeTypes.join(',')}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const types = useMemo(() => ({ containmentEdgeTypes, lineageEdgeTypes }), [typesKey])

  useEffect(() => {
    if (!served || !result) return
    const held = [...new Set([...result.members.map((m) => m.urn), ...result.wholeSubtree])]
    // What the canvas already draws in its layer needs nothing.
    const { nodes } = useCanvasStore.getState()
    const placed = new Set(nodes.filter((n) => typeof n.data?.feedLayerId === 'string').map((n) => n.id))
    const ask = held.filter((u) => !placed.has(u))
    const already = held.length - ask.length
    if (ask.length === 0) return
    const controller = new AbortController()
    const report = (done: number, outside: number, failed: number, finished: boolean) => {
      if (!controller.signal.aborted) setProgress({ key, value: { done: already + done, total: held.length, outside, failed, finished } })
    }
    report(0, 0, 0, false)
    loadIntoCanvas(served, provider, ask, {
      ...types, priority: 'background', signal: controller.signal,
      onProgress: (p) => report(p.placed, p.outside, p.failed, false),
    }).then(
      (out) => report(out.loaded.length, out.outside.length, out.failed.length, true),
      () => { /* stopped, or the view changed */ },
    )
    return () => controller.abort()
    // `result` is keyed by its spec and data: the same narrowing re-applied loads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [served, provider, key, types])

  return progress && progress.key === key ? progress.value : null
}
