/**
 * useLocateChange — find a change on the Context View canvas: opened down to, selected and scrolled
 * to, however deep it sits and whether or not its page has loaded.
 *
 * - **An entity that exists:** its containment chain (`getAncestorChains`, one read), then the reveal
 *   walk the search uses, which opens the spine without paging it.
 * - **A deletion:** its deleted chain, up to what it hung from that still exists (from the change set
 *   the canvas draws). It is pinned, so it's drawn past the 500 the canvas draws on its own. Then the
 *   anchor is revealed, the tombstone waited for (2 seconds at most), and the chain opened.
 * - **A relationship:** both ends, the target last, so it's the one selected.
 *
 * It says how it went: `found`; `nearby`, landing on the deepest level it could reach; or `missing`,
 * when nothing of it is on this canvas (an entity added after the revision open, say).
 */
import { useCallback } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { RevealSearchHit } from '@/hooks/useRevealSearchHit'
import type { ChangeListRow } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import type { AncestorRef } from '@/types/search'
import { deletedChain, indexRemovals } from './deletionGhosts'

export type LocateOutcome = 'found' | 'nearby' | 'missing'

/** How long a deletion may take to reach the canvas's change set, and then to be drawn, before
 *  Locate settles for less. */
export const TOMBSTONE_WAIT_MS = 2000

export interface LocateDeps {
  provider: GraphDataProvider
  /** The canvas's reveal walk: opens the spine down to a node, selects it and scrolls to it. */
  reveal: RevealSearchHit
  /** Open these rows. */
  expand: (ids: readonly string[]) => void
  scrollIntoView: (id: string) => void
  isContainmentEdgeType: (edgeType: string) => boolean
}

/** The canvas's change set indexed for its deletions, once per change set: every step asks. */
const indexed = new WeakMap<object, ReturnType<typeof indexRemovals>>()
function removalsOnCanvas(isContainmentEdgeType: (edgeType: string) => boolean) {
  const changes = useBranchStore.getState().activeChangeSet?.changes ?? []
  let index = indexed.get(changes)
  if (!index) { index = indexRemovals(changes, isContainmentEdgeType); indexed.set(changes, index) }
  return index
}

/** Resolves once the change set the canvas draws holds `urn`'s deletion — one a review just
 *  highlighted is still on its way — or false after `ms`. */
function inChangeSetWithin(urn: string, ms: number, isContainmentEdgeType: (edgeType: string) => boolean): Promise<boolean> {
  const holds = () => removalsOnCanvas(isContainmentEdgeType).nodes.has(urn)
  if (holds()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (held: boolean) => { unsubscribe(); window.clearTimeout(timer); resolve(held) }
    const unsubscribe = useBranchStore.subscribe(() => { if (holds()) done(true) })
    const timer = window.setTimeout(() => done(false), ms)
  })
}

/** Resolves once `urn` is in the canvas store, or false after `ms`. */
function drawnWithin(urn: string, ms: number): Promise<boolean> {
  if (useCanvasStore.getState()._nodeIndex.has(urn)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (drawn: boolean) => { unsubscribe(); window.clearTimeout(timer); resolve(drawn) }
    const unsubscribe = useCanvasStore.subscribe((s) => { if (s._nodeIndex.has(urn)) done(true) })
    const timer = window.setTimeout(() => done(false), ms)
  })
}

export function useLocateChange({ provider, reveal, expand, scrollIntoView, isContainmentEdgeType }: LocateDeps) {
  // Root first, as the reveal walks it; the provider answers parent first.
  const pathTo = useCallback(async (urn: string): Promise<AncestorRef[]> => {
    const chains = await provider.getAncestorChains?.([urn]).catch(() => null)
    return [...(chains?.[urn] ?? [])].reverse().map((u) => ({ urn: u, displayName: '', entityType: '' }))
  }, [provider])

  // `wanted` is asked after every wait: a locate the review has moved on from stops there.
  const locateNode = useCallback(async (urn: string, deleted: boolean, wanted: () => boolean): Promise<LocateOutcome> => {
    if (!deleted) {
      const path = await pathTo(urn)
      if (!wanted()) return 'missing'
      const landed = await reveal(urn, path)
      return landed.landedOn === 'hit' ? 'found' : landed.urn ? 'nearby' : 'missing'
    }
    if (!(await inChangeSetWithin(urn, TOMBSTONE_WAIT_MS, isContainmentEdgeType)) || !wanted()) return 'missing'
    const { chain, anchor } = deletedChain(removalsOnCanvas(isContainmentEdgeType), urn)
    useCanvasStore.getState().pinGhosts([urn])
    if (anchor) {
      const path = await pathTo(anchor)
      if (!wanted()) return 'missing'
      const landed = await reveal(anchor, path)
      if (landed.landedOn !== 'hit') return landed.urn ? 'nearby' : 'missing'
    }
    if (!(await drawnWithin(urn, TOMBSTONE_WAIT_MS))) return anchor ? 'nearby' : 'missing'
    if (!wanted()) return 'missing'
    // The anchor and the deleted entities above this one, open, so its row shows.
    expand([...(anchor ? [anchor] : []), ...chain.slice(0, -1)])
    useCanvasStore.getState().selectNode(urn)
    scrollIntoView(urn)
    return 'found'
  }, [reveal, pathTo, expand, scrollIntoView, isContainmentEdgeType])

  return useCallback(async (row: ChangeListRow, wanted: () => boolean = () => true): Promise<LocateOutcome> => {
    if (row.kind === 'edge') {
      // An end deleted with it is found as a deletion.
      const deleted = removalsOnCanvas(isContainmentEdgeType).nodes
      const ends = [row.sourceEntityId, row.targetEntityId].filter((e): e is string => !!e)
      let outcome: LocateOutcome = 'missing'
      for (const end of ends) if (wanted()) outcome = await locateNode(end, deleted.has(end), wanted)
      return outcome
    }
    return locateNode(row.urn || row.entityId, row.status === 'removed', wanted)
  }, [locateNode, isContainmentEdgeType])
}
