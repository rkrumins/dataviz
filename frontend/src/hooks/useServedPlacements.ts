/**
 * Where a view the server places draws what a trace reaches.
 *
 * A view made from a query keeps its members in a table of their own, and a subset view
 * places a search's matches as its base does — neither as the browser's placement could
 * work out from the layout. So a trace inside one asks the server where each entity it
 * reached is drawn (`POST /view-placements`): a member where its row is, anything else where
 * the view's layout — or the view it follows — would put it, or nowhere.
 *
 * Asked through the canvas's ServedPlacements (features/served-placement) when there is one,
 * else through one of its own: once per entity, merged, batched and asked again through a
 * slow or busy server. Read afresh when the view, its members (`resetKey`) or the data change.
 * Undefined when it isn't asked (`active` false) or can't be answered here — the canvas then
 * places as it always has.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { ServedPlacements } from '@/features/served-placement/servedPlacements'
import { useServedPlacementsService } from '@/features/served-placement/ServedPlacementContext'
import type { Placed } from '@/features/served-placement/types'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useGraphProvider } from '@/providers/GraphProviderContext'

export interface ServedPlacementsOptions {
  viewId: string | null
  active: boolean
  /** Every entity the trace holds, its containers among them (they decide its lane). */
  urns: readonly string[]
  /** Changes when the view's members or data change: what was answered is asked again.
   *  The canvas's own service is reset by the canvas; this keys the trace's own one. */
  resetKey: string
}

export interface ServedPlacementsState {
  /** Each answered entity's layer (null: nowhere in this view); undefined as for useServedPlacements. */
  placements: ReadonlyMap<string, string | null> | undefined
  /** The trace's entities still being asked about, and those that couldn't be (after retries). */
  pending: number
  failed: number
  /** Ask again for those that couldn't be asked: "Couldn't place N · Retry". */
  retryFailed: () => void
}

/** The layers of what the service has answered, read through — never copied. One per answer. */
class LayerView implements ReadonlyMap<string, string | null> {
  constructor(private readonly placed: ReadonlyMap<string, Placed>) {}
  get size() { return this.placed.size }
  get(urn: string) { return this.placed.get(urn)?.layerId }
  has(urn: string) { return this.placed.has(urn) }
  forEach(fn: (layer: string | null, urn: string, map: ReadonlyMap<string, string | null>) => void) {
    this.placed.forEach((p, urn) => fn(p.layerId, urn, this))
  }
  *entries(): MapIterator<[string, string | null]> { for (const [urn, p] of this.placed) yield [urn, p.layerId] }
  keys(): MapIterator<string> { return this.placed.keys() }
  *values(): MapIterator<string | null> { for (const p of this.placed.values()) yield p.layerId }
  [Symbol.iterator]() { return this.entries() }
}

/** Asks through whichever provider the canvas has now, so a service outlives its identity. */
class LatestProvider implements Pick<GraphDataProvider, 'viewPlacements'> {
  constructor(private provider: GraphDataProvider) {}
  set(provider: GraphDataProvider) { this.provider = provider }
  viewPlacements(...args: Parameters<NonNullable<GraphDataProvider['viewPlacements']>>) {
    return this.provider.viewPlacements!(...args)
  }
}

const subscribeToNothing = () => () => {}
const NOTHING_TO_RETRY = () => {}

export function useServedPlacementsState(opts: ServedPlacementsOptions): ServedPlacementsState {
  const provider = useGraphProvider()
  const shared = useServedPlacementsService()
  const { viewId, active, urns, resetKey } = opts
  const supported = typeof provider.viewPlacements === 'function'
  const sharedHere = shared && shared.viewId === viewId ? shared : null
  // No canvas service for this view (a canvas without one, or a test): the trace keeps its own.
  const [latest] = useState(() => new LatestProvider(provider))
  useEffect(() => { latest.set(provider) }, [latest, provider])
  const ownWanted = !sharedHere && active && supported
  const own = useMemo(
    () => (ownWanted && viewId ? new ServedPlacements({ viewId, provider: latest }) : null),
    [ownWanted, viewId, latest])
  useEffect(() => { own?.reset(resetKey) }, [own, resetKey])
  useEffect(() => () => own?.dispose(), [own])
  const service = active && viewId && supported ? (sharedHere ?? own) : null
  const version = useSyncExternalStore(
    service ? service.subscribe : subscribeToNothing,
    () => service?.version ?? 0,
    () => service?.version ?? 0,
  )
  const generation = service?.generation ?? 0

  // Asked once per entity: an ask for what is answered or on its way costs nothing. Asked
  // again after the answers were dropped (a reset, or the view moved under them).
  useEffect(() => {
    if (!service || service.unavailable || urns.length === 0) return
    service.placeOf(urns, { priority: 'now' }).catch(() => {})
  }, [service, urns, generation])

  const placements = useMemo(() => {
    void version
    if (!service || service.unavailable) return undefined
    return new LayerView(service.placements)
  }, [service, version])
  const { asking, failed } = useMemo(() => {
    void version
    return service ? service.counts(urns) : { asking: 0, failed: 0 }
  }, [service, urns, version])
  return {
    placements,
    pending: asking,
    failed,
    retryFailed: service ? () => service.retryFailed() : NOTHING_TO_RETRY,
  }
}

export function useServedPlacements(opts: ServedPlacementsOptions): ReadonlyMap<string, string | null> | undefined {
  return useServedPlacementsState(opts).placements
}
