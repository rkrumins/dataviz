/**
 * One ServedPlacements per canvas while it shows a view the server places (a view made from
 * a query, or a subset view) — what search results, Show on canvas, Narrow, lineage cues and
 * the trace read where the view draws an entity from.
 *
 * `resetKey` names what the answers were read for (the view's feed nonce, `updatedAt`,
 * definition hash, revision): a new one asks afresh. A new view, or a new provider, is a
 * new service.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'

import type { GraphDataProvider } from '@/providers/GraphDataProvider'

import { ServedPlacements } from './servedPlacements'

const ServedPlacementContext = createContext<ServedPlacements | null>(null)

export function ServedPlacementProvider({ viewId, fedView, resetKey, provider, children }: {
  viewId: string | null | undefined
  /** The canvas shows a view the server places: without it, no service (and nothing asked). */
  fedView: boolean
  resetKey: string
  provider: Pick<GraphDataProvider, 'viewPlacements'>
  children: ReactNode
}) {
  const served = fedView && !!viewId && typeof provider.viewPlacements === 'function'
  const service = useMemo(() => (served && viewId ? new ServedPlacements({ viewId, provider }) : null), [served, viewId, provider])
  // The first key only names what the answers are read for; a later one asks afresh.
  useEffect(() => { service?.reset(resetKey) }, [service, resetKey])
  useEffect(() => () => service?.dispose(), [service])
  return <ServedPlacementContext.Provider value={service}>{children}</ServedPlacementContext.Provider>
}

/** The canvas's service, or null where its view isn't one the server places. */
// eslint-disable-next-line react-refresh/only-export-components -- the provider and its hooks are one API
export function useServedPlacementsService(): ServedPlacements | null {
  return useContext(ServedPlacementContext)
}

const subscribeToNothing = () => () => {}

/** Changes with every answer, failure, ask and reset: what a reader of the service keys its memos on. */
// eslint-disable-next-line react-refresh/only-export-components
export function useServedVersion(): number {
  const service = useContext(ServedPlacementContext)
  return useSyncExternalStore(
    service ? service.subscribe : subscribeToNothing,
    () => service?.version ?? 0,
    () => service?.version ?? 0,
  )
}

const notAnswered = (): undefined => undefined

/** Where the view draws an entity: its layer, null for nowhere in this view, undefined while
 *  not answered yet (or not asked, or no service). Stable for the service's life — pair it with
 *  `useServedVersion()` in a memo's deps. */
// eslint-disable-next-line react-refresh/only-export-components
export function useServedLayerOf(): (urn: string) => string | null | undefined {
  const service = useContext(ServedPlacementContext)
  return useMemo(() => (service ? (urn: string) => service.get(urn)?.layerId : notAnswered), [service])
}
