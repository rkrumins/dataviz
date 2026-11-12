/**
 * useDeletionGhosts — keeps the canvas's committed-deletion ghost nodes AND edges in sync with the
 * draft-vs-main diff. Mount once per canvas, on every layout. See `deletionGhosts.ts` for the why.
 *
 * It runs again whenever the canvas gains or loses nodes: a deletion is drawn under a parent on the
 * canvas, so a parent loaded later brings its deleted children, and a collapse that dropped them
 * from the store gets them back.
 *
 * Runs only once hydration is `complete`, so the overlay lands ON TOP of the freshly re-hydrated live
 * state (a re-hydrate replaces the node/edge set; adding ghosts before it would just be wiped). Reads
 * the live sets via `getState()` (not a subscription) so it never loops on its own mutations.
 */
import { useEffect, useMemo, useState } from 'react'
import { queryClient } from '@/lib/queryClient'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { getChangeEntriesBatch, type ChangeListEntry, type ChangeListOrigin } from '@/services/versioningApiService'
import { BUSY_RETRY, VERSIONING_KEYS } from '../hooks/useVersioning'
import type { ChangeSet } from '../model/changeModel'
import { reconcileGhosts, isGhostNode, isGhostEdge } from './deletionGhosts'

/** The change list a change set came from, for asking it what a deleted entity was. */
export function listOriginOf(changeSet: ChangeSet | null): ChangeListOrigin | null {
  const o = changeSet?.changes[0]?.origin
  if (o?.source === 'compare') return { fromSeq: o.fromSeq, toSeq: o.toSeq }
  if (o?.source === 'branch') return { branchId: o.branchId }
  return null
}

const NONE_HIDDEN: ReadonlyMap<string, number> = new Map()

export function useDeletionGhosts(enabled: boolean) {
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const committedHidden = useBranchStore((s) => s.committedDiffHidden)
  const wsId = useBranchStore((s) => s.workspaceId)
  const graphId = useBranchStore((s) => s.graphId)
  const hydrationPhase = useCanvasStore((s) => s.hydrationPhase)
  const nodeCount = useCanvasStore((s) => s.nodes.length)
  // Deletions someone asked to see (Locate, "N deleted inside"): drawn beyond the cap.
  const pins = useCanvasStore((s) => s.ghostPins)
  const containmentTypes = useContainmentEdgeTypes()
  // Bumped when what deleted entities were arrives, to draw them.
  const [fetched, setFetched] = useState(0)

  // Ontology-driven: which edge types nest (drives whether a ghost edge is 'containment'). No literals.
  const isContainmentEdgeType = useMemo(() => {
    const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
    return (edgeType: string) => up.has(edgeType.toUpperCase())
  }, [containmentTypes])

  // Two revisions compared on the canvas draw their deletions too, wherever the canvas reads.
  const on = enabled || changeSet?.origin === 'compare'
  // A draft's "hide saved changes" is about the draft; it never hides a comparison.
  const hidden = committedHidden && changeSet?.origin !== 'compare'

  // An ask belongs to the change set it was made in: another draft or comparison starts without it.
  // None in between (a refetch) is no other one.
  const origin = listOriginOf(changeSet)
  const originKey = origin ? JSON.stringify(origin) : null
  useEffect(() => { if (originKey) useCanvasStore.getState().setGhostPinsOrigin(originKey) }, [originKey])

  useEffect(() => {
    // Overlay only after hydration settles, so ghosts aren't clobbered by the live-state load.
    if (hydrationPhase !== 'complete') return
    const state = useCanvasStore.getState()
    const origin = listOriginOf(changeSet)
    const entryKey = (id: string) => [...VERSIONING_KEYS.changeList(wsId ?? undefined, graphId, origin), 'entry', id]
    // What a deleted entity was, where a compact change list didn't say: asked for and kept per entity.
    const befores = new Map<string, Record<string, unknown>>()
    if (on && origin) {
      for (const c of changeSet?.changes ?? []) {
        if (c.kind !== 'node' || c.status !== 'removed' || c.before) continue
        const entry = queryClient.getQueryData<ChangeListEntry>(entryKey(c.entityId))
        if (entry?.before) befores.set(c.entityId, entry.before)
      }
    }
    const result = on
      ? reconcileGhosts(changeSet, state.nodes, state.edges, hidden, isContainmentEdgeType, undefined, befores, pins)
      : null
    const { nodesToAdd, nodesToRemove, edgesToAdd, edgesToRemove } = result ?? {
      nodesToAdd: [],
      edgesToAdd: [],
      nodesToRemove: state.nodes.filter(isGhostNode).map((n) => n.id),
      edgesToRemove: state.edges.filter(isGhostEdge).map((e) => e.id),
    }
    // removeNodes cascades edges touching them (incl. ghost edges); then clean up any remaining stale
    // ghost edges; then add nodes before edges so every ghost edge's endpoints already exist.
    if (nodesToRemove.length) state.removeNodes(nodesToRemove)
    if (edgesToRemove.length) state.removeEdges(edgesToRemove)
    if (nodesToAdd.length) state.addNodes(nodesToAdd as never)
    if (edgesToAdd.length) state.addEdges(edgesToAdd as never)

    // The ones picked to draw and not known yet: one request for all of them (at most the cap), each
    // answer kept under its own entry so its change-list row opens at once. A busy server is asked
    // again as the change lists are; any other failure leaves them undrawn.
    const missing = result?.missing ?? []
    const ask = !!(missing.length && origin && wsId && graphId)
    // Those on their way count as drawn, so the count doesn't flicker while they come.
    state.setDeletedDrawn(result && result.total > 0
      ? { drawn: result.drawn + (ask ? missing.length : 0), total: result.total }
      : null)
    state.setDeletedHidden(result?.hiddenByParent ?? NONE_HIDDEN)
    if (!result || !ask || !origin || !wsId || !graphId) return
    let live = true
    const ids = [...missing].sort()
    queryClient.fetchQuery({
      queryKey: [...VERSIONING_KEYS.changeList(wsId, graphId, origin), 'entriesBatch', ids.join(',')],
      queryFn: () => getChangeEntriesBatch(wsId, graphId, origin, ids),
      staleTime: Infinity,
      ...BUSY_RETRY,
    }).then((page) => {
      for (const entry of page.entries) queryClient.setQueryData(entryKey(entry.entityId), entry)
      if (live) setFetched((n) => n + 1)
    }, () => { if (live) state.setDeletedDrawn({ drawn: result.drawn, total: result.total }) })
    return () => { live = false }
  }, [on, changeSet, hidden, hydrationPhase, isContainmentEdgeType, nodeCount, fetched, wsId, graphId, pins])
}
