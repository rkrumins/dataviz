/**
 * Where a view the server places draws what a trace reaches.
 *
 * A view made from a query keeps its members in a table of their own, and a subset view
 * places a search's matches as its base does — neither as the browser's placement could
 * work out from the layout. So a trace inside one asks the server where each entity it
 * reached is drawn (`POST /view-placements`): a member where its row is, anything else where
 * the view's layout — or the view it follows — would put it, or nowhere.
 *
 * Asked once per entity, in sorted batches of 2,000, two at a time; a slow or busy server is
 * asked again after its `Retry-After` or a growing pause. Read afresh when the view, its
 * members (`resetKey`) or the data change. Undefined when it isn't asked (`active` false) or
 * can't be answered here — the canvas then places as it always has.
 */
import { useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { httpStatusOf, isTransientFailure, patientDelayMs } from '@/services/graphRequestFailure'

const BATCH = 2_000
const AT_ONCE = 2
const NONE: ReadonlyMap<string, string | null> = new Map()

export function useServedPlacements(opts: {
  viewId: string | null
  active: boolean
  /** Every entity the trace holds, its containers among them (they decide its lane). */
  urns: readonly string[]
  /** Changes when the view's members or data change: what was answered is asked again. */
  resetKey: string
}): ReadonlyMap<string, string | null> | undefined {
  const provider = useGraphProvider()
  const { viewId, active, urns, resetKey } = opts
  const supported = typeof provider.viewPlacements === 'function'
  const [served, setServed] = useState<{ key: string; map: ReadonlyMap<string, string | null>; unavailable: boolean }>(
    { key: '', map: NONE, unavailable: false })
  const key = `${viewId ?? ''}|${resetKey}`
  // What is being asked, and the asks of this view and members — stopped when either changes.
  const asking = useRef<{ key: string; urns: Set<string>; controller: AbortController } | null>(null)

  useEffect(() => () => asking.current?.controller.abort(), [])

  useEffect(() => {
    if (!active || !viewId || !supported) return
    if (asking.current?.key !== key) {
      asking.current?.controller.abort()
      asking.current = { key, urns: new Set(), controller: new AbortController() }
    }
    const run = asking.current
    const known = served.key === key ? served.map : NONE
    if (served.key === key && served.unavailable) return
    const unknown = [...new Set(urns)].filter((u) => !known.has(u) && !run.urns.has(u)).sort()
    if (unknown.length === 0) return
    for (const u of unknown) run.urns.add(u)
    const batches: string[][] = []
    for (let i = 0; i < unknown.length; i += BATCH) batches.push(unknown.slice(i, i + BATCH))
    const { signal } = run.controller

    const ask = async (batch: string[]): Promise<void> => {
      for (let failures = 0; !signal.aborted; failures++) {
        try {
          const out = await provider.viewPlacements!(viewId, batch, { signal })
          if (signal.aborted) return
          setServed((prev) => {
            const map = new Map(prev.key === key ? prev.map : NONE)
            for (const u of batch) map.set(u, out.placements[u]?.layerId ?? null)
            return { key, map, unavailable: false }
          })
          return
        } catch (err) {
          if (signal.aborted) return
          if (!isTransientFailure(err)) {
            // Not a view the server places (422), or one it can't read for this reader: the
            // canvas places as it always has.
            if (httpStatusOf(err) !== null) setServed((prev) => ({ key, map: prev.key === key ? prev.map : NONE, unavailable: true }))
            return
          }
          await new Promise((resolve) => window.setTimeout(resolve, patientDelayMs(err, failures)))
        }
      }
    }
    let next = 0
    const lane = async () => { while (next < batches.length && !signal.aborted) await ask(batches[next++]!) }
    for (let n = 0; n < Math.min(AT_ONCE, batches.length); n++) void lane()
  }, [active, viewId, supported, key, urns, provider, served])

  if (!active || !viewId || !supported) return undefined
  if (served.key !== key) return NONE
  return served.unavailable ? undefined : served.map
}
